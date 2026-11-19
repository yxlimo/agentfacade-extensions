// test/check.ts — dsh agent 适配器的自检（纯离线：假 agent + 注入 fetch）。
//
//   node --experimental-strip-types hosts/dsh/test/check.ts
//
// 覆盖：
//   · 映射：ModelSpec[] → llm-pi-ai 的 provider profile。输入是手写的 SPECS（下面那份），
//     期望值**手写**在本文件里（EXPECTED_PROFILE / EXPECTED_SECTION），不由任何程序生成。
//     「网关报文长什么样」不在这里 —— 那是 core 的事，形状只留一份。
//   · 双 agent：一份「最新形态」假 agent（mutate + revision + isVolatilePath）与一份
//     「旧形态」假 agent（没有 mutate、没有 revision、没有 isVolatilePath）。同一份模型清单、
//     同一份已有配置，两条路径必须走不同分支（mutate vs replace），互相能证明差异。
//   · 失败路径：网关不可达 / HTTP 500 / 非 JSON / 空 data / 全部缺 id → 一律不写。
//     「上一次成功的清单不会被空清单覆盖」单独立一条。
//   · 红线：源码里没有一条 fs 写路径（测试直接读源码断言），没有 configEditor。
//
// 断言用的是「注入的配置对象逐字比较」（快照式）：只断言 typeof 的用例什么也钉不住。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { apply, createState, describe, type DshPluginConfig, type DshState } from "../index.ts";
import {
  DSH_EFFORTS,
  DEFAULT_API,
  DEFAULT_API_KEY_ENV,
  endpointFor,
  toModelProfile,
  toProviderProfile,
  toReasoningEfforts,
  validateProviderProfile,
  validateReasoningEfforts,
  type PiAiProviderProfile,
} from "../provider.ts";
import { pickNamespace, probeCapabilities, type SettingsDescriptor, type SettingsHost, type SettingsPathOp } from "../settings-sync.ts";
import type { ModelSpec } from "../../../core/types.ts";
import { DEFAULT_GATEWAY, DEFAULT_TIMEOUT_MS, resolveDshGateway } from "../gateway-source.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 某个 ns 下 providers 里的所有路由；没写进去过就返回空对象（断言不能因为那份配置不存在而崩掉） */
function routesOf(host: FakeHost, ns = "llm-pi-ai"): Record<string, unknown> {
  const value = host.currentValue(ns) as { providers?: Record<string, unknown> } | undefined;
  return typeof value?.providers === "object" && value.providers !== null ? value.providers : {};
}

// ── 假 agent ───────────────────────────────────────────────────────────────
// 行为照 vendor 的 dsh-settings.d.ts：describe 返回 ns/schema/value/revision；
// mutate 只接受路径操作、按 expectedRevision 做乐观并发；replace 整段提交。

type WriteKind = "mutate" | "replace" | "update";

interface WriteRecord {
  kind: WriteKind;
  ns: string;
  ops?: SettingsPathOp[];
  section?: Record<string, unknown>;
  revision?: number;
}

interface HostShapes {
  mutate?: "revision" | "plain";
  replace?: "revision" | "plain";
  update?: "revision" | "plain";
  isVolatilePath?: (path: unknown) => boolean;
  givesRevision?: boolean;
  writable?: boolean;
}

interface FakeHost {
  settings: SettingsHost;
  writes: WriteRecord[];
  calls: { describe: number; mutate: number; replace: number; update: number };
  /** 每次能力探测的属性读取次数（验证「探测只做一次」） */
  probeHits: { mutate: number; replace: number; update: number };
  bumpAll(): void;
  beforeNextWrite(fn: (() => void) | null): void;
  beforeEveryWrite(value: boolean): void;
  currentValue(ns: string): unknown;
}

const DOCUMENT_PATH = "/var/lib/dsh/profiles/web/cordis.patch.yml";

function conflictError(expected: number, actual: number): Error {
  const error = new Error(`settings conflict: expected revision ${expected}, actual ${actual}`);
  (error as { code?: string }).code = "SETTINGS_CONFLICT";
  return error;
}

/** 深拷贝一份 section，按 path 写一格（模拟 agent 的 set 语义） */
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = node[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]] = value;
}

function makeHost(initial: readonly SettingsDescriptor[], shapes: HostShapes): FakeHost {
  const revisions = new Map<string, number>();
  const values = new Map<string, unknown>();
  for (const descriptor of initial) {
    revisions.set(descriptor.ns, descriptor.revision ?? 1);
    values.set(descriptor.ns, structuredClone(descriptor.value));
  }

  const writes: WriteRecord[] = [];
  const calls = { describe: 0, mutate: 0, replace: 0, update: 0 };
  const probeHits = { mutate: 0, replace: 0, update: 0 };
  let beforeNext: (() => void) | null = null;
  let beforeEvery = false;

  const bumpAll = (): void => {
    for (const ns of revisions.keys()) revisions.set(ns, (revisions.get(ns) ?? 0) + 1);
  };

  const runHook = (): void => {
    if (beforeNext) {
      const fn = beforeNext;
      beforeNext = null;
      fn();
    }
    if (beforeEvery) bumpAll();
  };

  // 乐观并发：agent 只在「真给了 expectedRevision」时校验；对不上就抛 SETTINGS_CONFLICT
  const checkRevision = (ns: string, expected: number | undefined): void => {
    if (shapes.givesRevision === false || expected === undefined) return;
    const actual = revisions.get(ns) ?? 0;
    if (expected !== actual) throw conflictError(expected, actual);
    revisions.set(ns, actual + 1);
  };

  const makeMutate = (mode: "revision" | "plain") =>
    mode === "revision"
      ? async function mutate(ns: string, ops: SettingsPathOp[], expectedRevision?: number): Promise<void> {
          calls.mutate++;
          runHook();
          checkRevision(ns, expectedRevision);
          const current = (values.get(ns) ?? {}) as Record<string, unknown>;
          for (const op of ops) {
            if (op.op === "set") setPath(current, op.path, structuredClone(op.value));
          }
          values.set(ns, current);
          writes.push({ kind: "mutate", ns, ops, revision: expectedRevision });
        }
      : async function mutate(ns: string, ops: SettingsPathOp[]): Promise<void> {
          calls.mutate++;
          runHook();
          const current = (values.get(ns) ?? {}) as Record<string, unknown>;
          for (const op of ops) {
            if (op.op === "set") setPath(current, op.path, structuredClone(op.value));
          }
          values.set(ns, current);
          writes.push({ kind: "mutate", ns, ops, revision: undefined });
        };

  const makeReplace = (mode: "revision" | "plain") =>
    mode === "revision"
      ? async function replace(ns: string, section: Record<string, unknown>, expectedRevision?: number): Promise<void> {
          calls.replace++;
          runHook();
          checkRevision(ns, expectedRevision);
          values.set(ns, structuredClone(section));
          writes.push({ kind: "replace", ns, section, revision: expectedRevision });
        }
      : async function replace(ns: string, section: Record<string, unknown>): Promise<void> {
          calls.replace++;
          runHook();
          values.set(ns, structuredClone(section));
          writes.push({ kind: "replace", ns, section, revision: undefined });
        };

  const makeUpdate = (mode: "revision" | "plain") =>
    mode === "revision"
      ? async function update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void> {
          calls.update++;
          runHook();
          checkRevision(ns, expectedRevision);
          const current = (values.get(ns) ?? {}) as Record<string, unknown>;
          values.set(ns, { ...current, ...structuredClone(patch) });
          writes.push({ kind: "update", ns, section: patch, revision: expectedRevision });
        }
      : async function update(ns: string, patch: Record<string, unknown>): Promise<void> {
          calls.update++;
          runHook();
          const current = (values.get(ns) ?? {}) as Record<string, unknown>;
          values.set(ns, { ...current, ...structuredClone(patch) });
          writes.push({ kind: "update", ns, section: patch, revision: undefined });
        };

  const settings = {
    get writable() {
      return shapes.writable ?? true;
    },
    documentPath: DOCUMENT_PATH,
    describe() {
      calls.describe++;
      return initial.map((descriptor) => ({
        ...descriptor,
        value: structuredClone(values.get(descriptor.ns)),
        revision: shapes.givesRevision === false ? undefined : revisions.get(descriptor.ns),
      }));
    },
  } as Record<string, unknown>;

  // 用 getter 挂写 API：探测每读一次属性就计数一次，「只探测一次」才有东西可断言
  for (const kind of ["mutate", "replace", "update"] as const) {
    const mode = shapes[kind];
    if (mode === undefined) continue;
    const fn = kind === "mutate" ? makeMutate(mode) : kind === "replace" ? makeReplace(mode) : makeUpdate(mode);
    Object.defineProperty(settings, kind, {
      configurable: true,
      enumerable: true,
      get() {
        probeHits[kind]++;
        return fn;
      },
    });
  }

  if (shapes.isVolatilePath) {
    const fn = shapes.isVolatilePath;
    Object.defineProperty(settings, "isVolatilePath", { configurable: true, enumerable: true, value: fn });
  }

  return {
    settings: settings as unknown as SettingsHost,
    writes,
    calls,
    probeHits,
    bumpAll,
    beforeNextWrite(fn) {
      beforeNext = fn;
    },
    beforeEveryWrite(value) {
      beforeEvery = value;
    },
    currentValue(ns) {
      return values.get(ns);
    },
  };
}

// ── 假网关的回答（**只有 id**）────────────────────────────────────────────

/**
 * 注册路径上用的清单：三条，**只给 id**。
 *
 * agent 的义务到 ModelSpec 为止；条目里其余字段长什么样是 core 的事（形状只留一份，在
 * core 的测试里）。这一层要验的是「拉到了、怎么写进 settings」，不是网关怎么渲染 ——
 * 所以这三条映射出来是 name=id、窗口 200000 / 4096（core 的缺省）、没有 reasoningEfforts。
 * 字段映射本身由下面第一组用例用显式 ModelSpec 钉。
 */
const SEEDED = {
  data: [{ id: "agentfacade-large" }, { id: "agentfacade-small" }, { id: "agentfacade-bare" }],
};

/**
 * 期望的 provider profile —— **手写快照**。改 provider.ts 的映射就要同步改这里，
 * 两边一起动是刻意的：防止「改了映射但测试还绿」。
 *
 *
 * api 是 openai-completions（docs/design.md 的实测结论），所以 baseURL 带 /v1。
 *
 * reasoningEfforts 按 llm-pi-ai 的**契约**写（不是按我们自己发出去的形状写）：
 *   · dict（不是数组），键是封闭词汇的 dsh 档位，键顺序 = 网关顺序；
 *   · off 的值是 null（协议里「什么也不发」），其余值是档位名本身；
 *   · agentfacade-small 的网关档位是 off/midium/high：midium 不在封闭词汇里 → 丢掉；
 *   · agentfacade-bare 没有任何已知档位 → **整个字段省略**（沿用已安装目录的能力）。
 * 缺省 context/output 是 core 的 200000 / 4096。
 */
const EXPECTED_PROFILE: PiAiProviderProfile = {
  displayName: "AgentFacade (main route)",
  api: "openai-completions",
  baseURL: "http://gateway.example:6450/v1",
  apiKeyEnv: "AGENTFACADE_API_KEY",
  models: [
    {
      id: "agentfacade-large",
      name: "Facade Large",
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoningEfforts: { low: "low", medium: "medium", high: "high", max: "max" },
    },
    {
      id: "agentfacade-small",
      name: "Facade Small",
      contextWindow: 200000,
      maxTokens: 8192,
      // midium 被过滤；off 的值必须是 null
      reasoningEfforts: { off: null, high: "high" },
    },
    { id: "agentfacade-bare", name: "Facade Bare", contextWindow: 200000, maxTokens: 4096 },
  ],
};

/**
 * 注册路径（apply）写进 settings 的那一份 —— **手写快照**。
 *
 * 与 EXPECTED_PROFILE 不同，这份是「假网关只给 id」那一路的产物：name 退回 id、窗口是
 * core 的缺省 200000 / 4096、没有 reasoningEfforts（网关没报档位 → core 给空数组 →
 * 交集为空 → 整个字段省略）。两份快照各自钉一段：上面那份钉映射，这份钉管线。
 */
const EXPECTED_APPLIED_PROFILE: PiAiProviderProfile = {
  displayName: "AgentFacade (main route)",
  api: "openai-completions",
  baseURL: "http://gateway.example:6450/v1",
  apiKeyEnv: "AGENTFACADE_API_KEY",
  models: [
    { id: "agentfacade-large", name: "agentfacade-large", contextWindow: 200000, maxTokens: 4096 },
    { id: "agentfacade-small", name: "agentfacade-small", contextWindow: 200000, maxTokens: 4096 },
    { id: "agentfacade-bare", name: "agentfacade-bare", contextWindow: 200000, maxTokens: 4096 },
  ],
};

/** 假 agent describe() 里已存在的配置：别的路由 + 一个别的键（replace 必须原样保留） */
const EXISTING_SECTION = {
  providers: {
    buddy: {
      displayName: "Buddy Router",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      api: "anthropic-messages",
      baseURL: "http://192.168.50.4:6450/v1",
      models: [{ id: "dsh-manager", contextWindow: 1000000, maxTokens: 128000 }],
    },
  },
  agentDefaultModel: { provider: "buddy", model: "dsh-manager" },
};

/** replace 路径提交的整段 section —— 手写快照（别的路由与别的键都要还在） */
const EXPECTED_SECTION = {
  providers: {
    buddy: {
      displayName: "Buddy Router",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      api: "anthropic-messages",
      baseURL: "http://192.168.50.4:6450/v1",
      models: [{ id: "dsh-manager", contextWindow: 1000000, maxTokens: 128000 }],
    },
    agentfacade: EXPECTED_APPLIED_PROFILE,
  },
  agentDefaultModel: { provider: "buddy", model: "dsh-manager" },
};

/** llm-pi-ai 条目的 schema：providers 是它的配置键 —— ns 就按这个认 */
const PI_AI_SCHEMA = { type: "object", properties: { providers: { type: "object" }, defaults: {} } };

function descriptorsFor(value: unknown, ns = "llm-pi-ai"): SettingsDescriptor[] {
  return [
    { ns: "ui-settings-general", schema: { type: "object", properties: { welcomeNoticeVersion: { type: "string" } } }, value: { welcomeNoticeVersion: "2026-09-28.1" } },
    { ns, schema: PI_AI_SCHEMA, value },
  ];
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** 注入 fetch：记录请求的 URL，返回给定响应 */
function captureFetch(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const GATEWAY = "http://gateway.example:6450";

/**
 * 「主机 + 路径」，去掉 query。
 *
 * 清单地址上挂什么方言（`?dialect=` 之类）是 core 的事：这一层钉整条 URL，core 换个方言
 * 这一层就红 —— 那不是 agent 的行为变了。所以只钉打到哪台机器的哪条路径。
 */
function listTarget(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** 一次正常 apply 的配置：注入地址与 fetch，别的走默认 */
function configWith(fetchImpl: typeof fetch, extra: Partial<DshPluginConfig> = {}): DshPluginConfig {
  return { gateway: GATEWAY, fetchImpl, env: {}, warn: () => {}, ...extra };
}


/**
 * 一条 ModelSpec 的构造器：只写这条用例关心的字段，其余按「网关没报」的默认值。
 * 默认值不是断言（每处断言仍逐字写出期望结果），只是 ModelSpec 有八格。
 */
function spec(fields: Partial<ModelSpec> & { id: string }): ModelSpec {
  return {
    displayName: fields.id,
    reasoning: true,
    efforts: [],
    contextWindow: 200000,
    maxOutputTokens: 4096,
    toolCall: null,
    modalities: null,
    cost: null,
    ...fields,
  };
}

/**
 * 映射用例的输入：三条 ModelSpec —— **agent 的输入**，不是网关的报文。
 *
 * 覆盖 dsh 的收敛规则真正要处理的形状：四档齐全、带拼错的 `midium`、以及一条完全没有
 * 已知档位的（交集为空 → 整个字段省略）。价格与模态这一侧不表达（provider schema 没有
 * 那两格），所以按「网关没报」写。
 */
const SPECS: ModelSpec[] = [
  spec({ id: "agentfacade-large", displayName: "Facade Large", efforts: ["low", "medium", "high", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "agentfacade-small", displayName: "Facade Small", efforts: ["off", "midium", "high"], contextWindow: 200000, maxOutputTokens: 8192 }),
  spec({ id: "agentfacade-bare", displayName: "Facade Bare" }),
];
// ── 复验入口：固定 catalog 走真实管线，打印将要写进 settings 的 profile JSON ──
//   node --experimental-strip-types hosts/dsh/test/check.ts --dump
// 不联网、不读网关：输入就是上面那份 SPECS（与映射用例同一份数据）。
if (process.argv.includes("--dump")) {
  const profile = toProviderProfile(SPECS, { baseUrl: GATEWAY, api: DEFAULT_API, apiKeyEnv: DEFAULT_API_KEY_ENV });
  console.log(JSON.stringify(profile, null, 2));
  process.exit(0);
}
// ── 1. 映射：ModelSpec → llm-pi-ai provider profile ─────────────────────

console.log("provider profile（期望值手写）");

{
  const profile = toProviderProfile(SPECS, { baseUrl: GATEWAY, api: DEFAULT_API, apiKeyEnv: DEFAULT_API_KEY_ENV });
  check("默认方言 openai-completions：baseURL 带 /v1（docs/design.md 的实测结论）", profile.baseURL === `${GATEWAY}/v1`, profile.baseURL);
  check("provider profile 与手写快照逐字一致", same(profile, EXPECTED_PROFILE), JSON.stringify(profile));
  // ── 契约断言：按 llm-pi-ai 的真实 schema 断言，而不是按我们自己发出去的形状 ──
  const large = profile.models[0].reasoningEfforts as Record<string, string | null>;
  check("回归钉：reasoningEfforts 不是数组（agent Config 只认 false | dict）", !Array.isArray(profile.models[0].reasoningEfforts));
  check("档位 dict 的键顺序 = 网关顺序（不排序、不补档）", same(Object.keys(large), ["low", "medium", "high", "max"]), JSON.stringify(Object.keys(large)));
  check("键全在 dsh 封闭词汇内（schemastery 拒未知键）", Object.keys(large).every((k) => (DSH_EFFORTS as readonly string[]).includes(k)), JSON.stringify(Object.keys(large)));
  check("非 off 档位的值就是档位名本身", large.low === "low" && large.max === "max");
  const small = profile.models[1].reasoningEfforts as Record<string, string | null>;
  check("dsh 不认识的拼写被过滤（midium 不出现在 dict 里）", !("midium" in small) && same(Object.keys(small), ["off", "high"]), JSON.stringify(Object.keys(small)));
  check("off 的值是 null（协议：什么也不发）", small.off === null);
  check("交叉为空：整个字段省略（不是 []，也不是 {}）", !("reasoningEfforts" in profile.models[2]) && profile.models[2].reasoningEfforts === undefined);
  const dropped = toModelProfile(spec({ id: "x", displayName: "X", efforts: ["midium", "none"], contextWindow: 1, maxOutputTokens: 1 }));
  check("上游档位全部不在封闭词汇里：字段缺席而不是空 dict / 空数组", !("reasoningEfforts" in dropped));
  check("toReasoningEfforts：off → null、其余值就是档位名", same(toReasoningEfforts(["off", "high"]), { off: null, high: "high" }));
  check("toReasoningEfforts：未知拼写 → undefined（调用方据此省略字段）", toReasoningEfforts(["midium", "none"]) === undefined);
  check("toReasoningEfforts：重复档位只留第一次且顺序不变", same(Object.keys(toReasoningEfforts(["high", "high", "low"]) ?? {}), ["high", "low"]));
  // 价格 / 模态 / 工具调用：dsh 这一版 profile 没有对应的格子。钉的是「不泄漏」——
  // 哪天有人图省事把 spec 整个展开进 profile，这条会红，而不是悄悄写出一份 schema 不认的配置。
  const extra = toModelProfile(
    spec({ id: "x", displayName: "X", contextWindow: 1000, maxOutputTokens: 100, toolCall: false, modalities: { input: ["text"], output: ["text"] }, cost: { inputPerMillion: 3, outputPerMillion: 15 } }),
  );
  check(
    "spec 里 dsh 表达不了的字段（toolCall / modalities / cost）不出现在 profile 条目里",
    same(Object.keys(extra).sort(), ["contextWindow", "id", "maxTokens", "name"]),
    JSON.stringify(Object.keys(extra)),
  );

  const anthropic = toProviderProfile(SPECS, { baseUrl: GATEWAY, api: "anthropic-messages", apiKeyEnv: DEFAULT_API_KEY_ENV });
  check("可配置方言 anthropic-messages：baseURL 到路由根（不拼 /v1）", anthropic.baseURL === GATEWAY, anthropic.baseURL);
  check("anthropic-messages 的 profile 除 api/baseURL 外与手写快照一致", same(anthropic, { ...EXPECTED_PROFILE, api: "anthropic-messages", baseURL: GATEWAY }));

  check("endpointFor：openai-completions 拼 /v1、末尾斜杠不重复", endpointFor("http://x:6450/", "openai-completions") === "http://x:6450/v1");
  check("endpointFor：anthropic-messages 只去末尾斜杠", endpointFor("http://x:6450/", "anthropic-messages") === "http://x:6450");
}

// ── 2. provider 形状校验（旧形态 agent 没有 isVolatilePath 时的替身）─────────

console.log("validateProviderProfile");

const badProfile = (patch: Record<string, unknown>): unknown => ({ ...EXPECTED_PROFILE, models: [{ ...EXPECTED_PROFILE.models[0], ...patch }] });
check("合法 profile 通过（reasoningEfforts 是 dict 形态）", validateProviderProfile(EXPECTED_PROFILE) === null);
check("未知方言被拒（提示支持的两个）", (validateProviderProfile({ ...EXPECTED_PROFILE, api: "carrier-pigeon" }) ?? "").includes("is not one of openai-completions, anthropic-messages"));
check("空 models 数组被拒（空清单绝不写进配置）", (validateProviderProfile({ ...EXPECTED_PROFILE, models: [] }) ?? "").includes("non-empty array"));
check("缺 apiKeyEnv 被拒", (validateProviderProfile({ ...EXPECTED_PROFILE, apiKeyEnv: "" }) ?? "").includes("apiKeyEnv"));
check("非 http(s) baseURL 被拒", (validateProviderProfile({ ...EXPECTED_PROFILE, baseURL: "file:///tmp/x" }) ?? "").includes("http(s) URL"));
check(
  "模型缺 contextWindow 被拒",
  (validateProviderProfile({ ...EXPECTED_PROFILE, models: [{ ...EXPECTED_PROFILE.models[0], contextWindow: 0 }] }) ?? "").includes("contextWindow"),
);
// 契约边界：数组（这次的错法）、封闭词汇外的键、off 非 null、合法省略、false 合法
check("reasoningEfforts 写成数组被拒（正是这次的错法）", (validateProviderProfile(badProfile({ reasoningEfforts: ["low", "high"] })) ?? "").includes("must be false or a dict"));
check("封闭词汇外的键被拒（midium）", (validateProviderProfile(badProfile({ reasoningEfforts: { low: "low", midium: "midium" } })) ?? "").includes("is not one of off, minimal"));
check("off 的值不是 null 被拒", (validateProviderProfile(badProfile({ reasoningEfforts: { off: "off" } })) ?? "").includes("reasoningEfforts.off must be null"));
check("字段省略合法（省略 = 沿用已安装目录的能力声明）", validateProviderProfile(badProfile({ reasoningEfforts: undefined })) === null);
check("validateReasoningEfforts(false) 合法（契约的另一半）", validateReasoningEfforts(false) === null);
check("dict 的合法最小样本：{ off: null, medium: 'medium' }", validateReasoningEfforts({ off: null, medium: "medium" }) === null);

// ── 3. 能力探测：按形状判定，不按版本号 ─────────────────────────────────

console.log("probeCapabilities（形状判定）");

{
  const newForm = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", replace: "revision", isVolatilePath: () => true, givesRevision: true });
  const caps = probeCapabilities(newForm.settings);
  check("最新形态：write=mutate", caps.write === "mutate");
  check("最新形态：revision=true（写 API 接受第三参）", caps.revision === true);
  check("最新形态：agent 自己管 volatile，插件不再校验形状", caps.ownVolatileCheck === false);
  check("最新形态：不需要合并 section", caps.mergeSection === false);
  check("最新形态：没有 problems", caps.problems.length === 0, caps.problems.join("; "));

  const oldForm = makeHost(descriptorsFor(EXISTING_SECTION), { replace: "plain", givesRevision: false });
  const oldCaps = probeCapabilities(oldForm.settings);
  check("旧形态（没有 mutate）：write=replace", oldCaps.write === "replace");
  check("旧形态（没有 revision）：revision=false", oldCaps.revision === false);
  check("旧形态（没有 isVolatilePath）：插件自己校验形状", oldCaps.ownVolatileCheck === true);
  check("旧形态：必须合并 section 再提交", oldCaps.mergeSection === true);
  check("旧形态：没有 problems（replace 就是它的写 API）", oldCaps.problems.length === 0, oldCaps.problems.join("; "));

  const noWrite = makeHost(descriptorsFor(EXISTING_SECTION), {});
  const noWriteCaps = probeCapabilities(noWrite.settings);
  check("一条写 API 都没有：problems 里说明，且点名不退化成写文件", noWriteCaps.problems.length === 1 && noWriteCaps.problems[0].includes("refusing to fall back"));

  const notWritable = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", writable: false });
  const notWritableCaps = probeCapabilities(notWritable.settings);
  check("writable=false：problems 里带上 profile patch 路径", notWritableCaps.problems.some((p) => p.includes(DOCUMENT_PATH)), notWritableCaps.problems.join("; "));

  const noDescribe = probeCapabilities(undefined);
  check("ctx.settings 缺失：problems 说明 + 不退化成写文件", noDescribe.problems.length === 1 && noDescribe.problems[0].includes("never falls back to editing files"));
}

// ── 4. ns 发现：不写死 id ────────────────────────────────────────────────

console.log("pickNamespace（按 schema 的 providers 键，不写死 id）");

{
  const picked = pickNamespace(descriptorsFor(EXISTING_SECTION));
  check("两条描述里挑 schema 含 providers 的那条", picked.ok && picked.descriptor.ns === "llm-pi-ai");
  check("按 schema 命中（matchedBy=schema）", picked.ok && picked.matchedBy === "schema");

  const alias = pickNamespace(descriptorsFor(EXISTING_SECTION, "@deepseek-ai/dsh-llm-pi-ai"));
  check("ns 换成 @deepseek-ai/dsh-llm-pi-ai 也能找到（没有写死 id）", alias.ok && alias.descriptor.ns === "@deepseek-ai/dsh-llm-pi-ai");

  const valueOnly = pickNamespace([{ ns: "the-pi-entry" }, { ns: "x" }, { ns: "the-pi-entry-2", value: { providers: {} } }]);
  check("没有 schema 时按 value 里的 providers 命中", valueOnly.ok && valueOnly.descriptor.ns === "the-pi-entry-2" && valueOnly.matchedBy === "value");

  const missing = pickNamespace([{ ns: "ui-settings-general", schema: { properties: { welcomeNoticeVersion: {} } }, value: {} }]);
  check("哪条都不含 providers：报错并列出 describe 到的 id", !missing.ok && missing.error.includes("ui-settings-general") && missing.error.includes("nothing was written"));
}

// ── 5. 双 agent：同一场景走两条不同分支 ────────────────────────────────────

console.log("双 agent：同一份响应 + 同一份已有配置");

let hostNew: FakeHost;
let hostOld: FakeHost;
let stateNew: DshState;
let stateOld: DshState;

{
  const fetchN = captureFetch(() => jsonResponse(SEEDED));
  hostNew = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", replace: "revision", isVolatilePath: () => true, givesRevision: true });
  stateNew = createState();
  const reportNew = await apply({ settings: hostNew.settings }, configWith(fetchN.fetchImpl), stateNew);

  check("新形态：apply 成功", reportNew.ok === true, reportNew.ok ? "" : reportNew.error);
  check("新形态：writePath=mutate+revision", reportNew.ok && reportNew.writePath === "mutate+revision", stateNew.writePath);
  check("新形态：走 mutate，没碰 replace", hostNew.calls.mutate === 1 && hostNew.calls.replace === 0, JSON.stringify(hostNew.calls));
  check(
    "新形态：注入的 ops 逐字等于手写快照（路径 + 值）",
    same(hostNew.writes[0]?.ops, [{ op: "set", path: ["providers", "agentfacade"], value: EXPECTED_APPLIED_PROFILE }]),
    JSON.stringify(hostNew.writes[0]?.ops),
  );
  check("新形态：带上 describe 读到的 revision=1", hostNew.writes[0]?.revision === 1);
  check("新形态：写进去的值与手写快照一致", same(routesOf(hostNew)["agentfacade"], EXPECTED_APPLIED_PROFILE));
  check("新形态：ns 是 describe 里找到的那条", stateNew.ns === "llm-pi-ai", String(stateNew.ns));
  check(
    "新形态：fetch 打的是 {gateway}/v1/models（query 里的方言由 core 决定，这一层不钉）",
    fetchN.urls.length === 1 && listTarget(fetchN.urls[0]) === `${GATEWAY}/v1/models`,
    JSON.stringify(fetchN.urls),
  );
  check("新形态：describe(state) 里能看见选了哪条分叉", describe(stateNew).some((line) => line === "Write path: mutate+revision"), describe(stateNew).join(" | "));

  const fetchO = captureFetch(() => jsonResponse(SEEDED));
  hostOld = makeHost(descriptorsFor(EXISTING_SECTION), { replace: "plain", givesRevision: false });
  stateOld = createState();
  const reportOld = await apply({ settings: hostOld.settings }, configWith(fetchO.fetchImpl), stateOld);

  check("旧形态：apply 成功", reportOld.ok === true, reportOld.ok ? "" : reportOld.error);
  check("旧形态：writePath=replace（没有 mutate）", reportOld.ok && reportOld.writePath === "replace", stateOld.writePath);
  check("旧形态：走 replace，没碰 mutate（agent 也没有）", hostOld.calls.replace === 1 && hostOld.writes[0]?.kind === "replace", JSON.stringify(hostOld.calls));
  check("旧形态：没有 revision → 交出去的 revision 是 undefined（无并发保护）", hostOld.writes[0]?.revision === undefined);
  check(
    "旧形态：整段 section 逐字等于手写快照（别人的路由与键都在）",
    same(hostOld.writes[0]?.section, EXPECTED_SECTION),
    JSON.stringify(hostOld.writes[0]?.section),
  );
  check("旧形态：写入后 section 里 agentfacade 与手写快照一致", same(routesOf(hostOld)["agentfacade"], EXPECTED_APPLIED_PROFILE));
  const setOpValue = (write: WriteRecord | undefined): unknown => (write?.ops?.[0] as { value?: unknown } | undefined)?.value;
  check("两条路径写出的 provider 值相同（差异只在怎么交，不在交什么）", same(setOpValue(hostNew.writes[0]), (hostOld.writes[0]?.section?.providers as Record<string, unknown> | undefined)?.agentfacade));

  check(
    "两条路径的可见痕迹不同：mutate+revision vs replace",
    stateNew.writePath === "mutate+revision" && stateOld.writePath === "replace",
    `${stateNew.writePath} vs ${stateOld.writePath}`,
  );
}

// ── 6. 能力探测只做一次（缓存）──────────────────────────────────────────

console.log("能力探测缓存");

{
  const host = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: () => true, givesRevision: true });
  const state = createState();
  const fetch1 = captureFetch(() => jsonResponse(SEEDED));
  await apply({ settings: host.settings }, configWith(fetch1.fetchImpl), state);
  const afterFirst = host.probeHits.mutate;
  const fetch2 = captureFetch(() => jsonResponse(SEEDED));
  await apply({ settings: host.settings }, configWith(fetch2.fetchImpl), state);
  // 一次全量探测要读两次 mutate（typeof + 取函数引用）；一次写入再读一次。
  // 所以第一次 apply 读完是 3，第二次如果重新探测会是 +2，复用缓存则只 +1（写入那一下）。
  check("第一次 apply 探测过 mutate（属性读过）", afterFirst > 0, String(afterFirst));
  check("第二次 apply 复用缓存：没有重新探测（只多出写入用的那一次读）", host.probeHits.mutate - afterFirst === 1, `${afterFirst} → ${host.probeHits.mutate}`);
  check("两次 apply 都写了（缓存的是探测结果，不是跳过写入）", host.calls.mutate === 2, JSON.stringify(host.calls));
}

// ── 7. 乐观并发：SETTINGS_CONFLICT → 重读 describe 再试一次 ──────────────

console.log("SETTINGS_CONFLICT 处理");

{
  const host = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: () => true, givesRevision: true });
  const state = createState();
  host.beforeNextWrite(() => host.bumpAll()); // 读与写之间别人动了一次配置
  const fetchOnce = captureFetch(() => jsonResponse(SEEDED));
  const report = await apply({ settings: host.settings }, configWith(fetchOnce.fetchImpl), state);
  check("冲突后重读 describe 再写：成功", report.ok === true, report.ok ? "" : report.error);
  check("重读过 describe（describe 调了 2 次）", host.calls.describe === 2, JSON.stringify(host.calls));
  check("最终写入一次，带的是重读后的 revision=2", host.writes.length === 1 && host.writes[0].revision === 2, JSON.stringify(host.writes));

  const stubborn = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: () => true, givesRevision: true });
  const stubbornState = createState();
  stubborn.beforeEveryWrite(true); // 每次写之前都有别人动配置
  const fetchStubborn = captureFetch(() => jsonResponse(SEEDED));
  const stubbornReport = await apply({ settings: stubborn.settings }, configWith(fetchStubborn.fetchImpl), stubbornState);
  check("只重试一次：持续冲突就报错，不循环", stubbornReport.ok === false && (stubbornReport as { error: string }).error.includes("SETTINGS_CONFLICT persisted after one retry"));
  check("持续冲突时一次都没写进去", stubborn.writes.length === 0, JSON.stringify(stubborn.writes));
  check("持续冲突时 describe 读了两轮（初始 + 重读）", stubborn.calls.describe === 2, JSON.stringify(stubborn.calls));

  const plain = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "plain", givesRevision: false });
  const plainState = createState();
  const fetchPlain = captureFetch(() => jsonResponse(SEEDED));
  const plainReport = await apply({ settings: plain.settings }, configWith(fetchPlain.fetchImpl), plainState);
  check("没有 revision 的 agent：写一次就成（读一次写一次，无并发保护）", plainReport.ok === true && plain.writes[0].revision === undefined);
  check("没有 revision 的 agent：writePath=mutate", plainState.writePath === "mutate", plainState.writePath);
}

// ── 8. 失败路径：一律不写 ────────────────────────────────────────────────

console.log("失败路径：网关的问题不改配置");

async function failingScenario(name: string, respond: () => Response | Promise<Response>, expectInError: string, opts: Partial<DshPluginConfig> = {}): Promise<void> {
  const host = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: () => true, givesRevision: true });
  const state = createState();
  const fetchC = captureFetch(respond);
  const report = await apply({ settings: host.settings }, configWith(fetchC.fetchImpl, opts), state);
  check(`${name}：apply 失败`, report.ok === false);
  check(`${name}：错误里有「${expectInError}」`, !report.ok && report.error.includes(expectInError), report.ok ? "" : report.error);
  check(`${name}：一次写都没有`, host.writes.length === 0 && host.calls.mutate === 0 && host.calls.replace === 0, JSON.stringify(host.writes));
  check(`${name}：state.lastError 被写上`, state.lastError !== null && state.lastError.includes(expectInError));
  check(`${name}：state.gateway 已记下试过的地址`, state.gateway === GATEWAY, state.gateway);
}

await failingScenario("网关不可达", () => { throw new TypeError("fetch failed"); }, "unreachable");
await failingScenario("HTTP 500", () => new Response("boom", { status: 500 }), "answered HTTP 500");
await failingScenario("非 JSON 响应", () => new Response("definitely not json", { status: 200, headers: { "content-type": "text/plain" } }), "did not answer a JSON object");
await failingScenario("空 data", () => jsonResponse({ data: [] }), "listed no models");
// 报文用 openai 渲染：这条走的是完整链路（假网关 → core 解析 → ModelSpec），喂的必须是
// 网关真实形状，不能用旧渲染的词汇，否则这行会在下次渲染变化时变成假的通过。
await failingScenario("所有条目都没有 id", () => jsonResponse({ data: [{ name: "no-id" }] }), "listed no models");

{
  // 超时：fetch 永不返回，靠 AbortSignal 收尾
  const host = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: () => true, givesRevision: true });
  const state = createState();
  const never = (async (_url: string, init?: RequestInit) => {
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as unknown as typeof fetch;
  const report = await apply({ settings: host.settings }, configWith(never, { timeoutMs: 20 }), state);
  check("超时：apply 失败并报 timed out", report.ok === false && !report.ok && report.error.includes("timed out after 20ms"), report.ok ? "" : report.error);
  check("超时：不写", host.writes.length === 0);
}

// ── 9. 空清单绝不覆盖上一次成功的清单 ────────────────────────────────────

console.log("空清单 / 之后的失败不覆盖已写入的 provider");

{
  const host = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: () => true, givesRevision: true });
  const state = createState();

  const first = await apply({ settings: host.settings }, configWith(captureFetch(() => jsonResponse(SEEDED)).fetchImpl), state);
  check("第一轮成功并写入 3 个模型", first.ok === true && host.writes.length === 1 && state.lastGood?.models.length === 3, JSON.stringify(first));

  const emptyWarns: string[] = [];
  const second = await apply({ settings: host.settings }, configWith(captureFetch(() => jsonResponse({ data: [] })).fetchImpl, { warn: (message) => emptyWarns.push(message) }), state);
  check("第二轮空清单：失败", second.ok === false);
  check("第二轮空清单：没有再写（mutate 仍只有 1 次）", host.calls.mutate === 1, String(host.calls.mutate));
  check("第二轮空清单：settings 里的 agentfacade 仍是上一轮的 3 个模型", (((routesOf(host)["agentfacade"]) as PiAiProviderProfile | undefined)?.models.length ?? 0) === 3);
  check("第二轮空清单：state.lastGood 保持 3 个模型（不置空）", state.lastGood?.models.length === 3);
  check("第二轮空清单：警告里说明保留了几个模型（文案归 agent，state.lastError 只有原因）", emptyWarns.some((w) => w.includes("keeping the last known 3 model(s)")), emptyWarns.join(" | "));
  check("第二轮空清单：state.lastError 是网关的原因原文", state.lastError !== null && state.lastError.includes("listed no models"), String(state.lastError));

  const third = await apply({ settings: host.settings }, configWith(captureFetch(() => { throw new TypeError("fetch failed"); }).fetchImpl), state);
  check("第三轮不可达：同样失败且不写", third.ok === false && host.calls.mutate === 1);
  check("第三轮不可达：state.lastGood 仍保持 3 个模型", state.lastGood?.models.length === 3);
}

// ── 10. 旧形态下的形状校验（写坏了没人替我们拦）──────────────────────────

console.log("旧形态 + 坏配置：拒绝而不是写坏");

{
  const host = makeHost(descriptorsFor(EXISTING_SECTION), { replace: "plain", givesRevision: false });
  const state = createState();
  const report = await apply(
    { settings: host.settings },
    configWith(captureFetch(() => jsonResponse(SEEDED)).fetchImpl, { api: "carrier-pigeon" }),
    state,
  );
  check("不支持的方言：apply 失败", report.ok === false);
  check("不支持的方言：replace 一次都没调", host.calls.replace === 0);
  check("不支持的方言：错误里点名支持的两个方言", !report.ok && report.error.includes("is not one of openai-completions, anthropic-messages"), report.ok ? "" : report.error);
  check("不支持的方言：settings 里没有 agentfacade", routesOf(host)["agentfacade"] === undefined);
}

// ── 11. volatile 判定：新旧两条形态 ────────────────────────────────────

console.log("isVolatilePath 两侧");

{
  const acceptsArray = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: (p: unknown) => Array.isArray(p), givesRevision: true });
  const s1 = createState();
  const r1 = await apply({ settings: acceptsArray.settings }, configWith(captureFetch(() => jsonResponse(SEEDED)).fetchImpl), s1);
  check("isVolatilePath 收数组：接受 providers.agentfacade", r1.ok === true && acceptsArray.calls.mutate === 1);

  const acceptsDotted = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: (p: unknown) => typeof p === "string" && p === "providers.agentfacade", givesRevision: true });
  const s2 = createState();
  const r2 = await apply({ settings: acceptsDotted.settings }, configWith(captureFetch(() => jsonResponse(SEEDED)).fetchImpl), s2);
  check("isVolatilePath 只收点路径：也接受（私有 API 没 vendor 签名，两种形状都试）", r2.ok === true && acceptsDotted.calls.mutate === 1);

  const rejects = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", isVolatilePath: () => false, givesRevision: true });
  const s3 = createState();
  const r3 = await apply({ settings: rejects.settings }, configWith(captureFetch(() => jsonResponse(SEEDED)).fetchImpl), s3);
  check("agent 说不 volatile：报错且不写", r3.ok === false && rejects.writes.length === 0 && !r3.ok && r3.error.includes("non-volatile"), r3.ok ? "" : r3.error);
}

// ── 12. 没有写入能力：报错说明，绝不变玩具 ───────────────────────────────

console.log("agent 没有可用的写入 API");

{
  const bare = makeHost(descriptorsFor(EXISTING_SECTION), {});
  const s1 = createState();
  const r1 = await apply({ settings: bare.settings }, configWith(captureFetch(() => jsonResponse(SEEDED)).fetchImpl), s1);
  check("describe 在但两条写 API 都没有：失败并说明不退化成写文件", r1.ok === false && !r1.ok && r1.error.includes("refusing to fall back"), r1.ok ? "" : r1.error);
  check("没有任何写入发生", bare.writes.length === 0 && bare.calls.mutate === 0 && bare.calls.replace === 0);

  const notWritable = makeHost(descriptorsFor(EXISTING_SECTION), { mutate: "revision", writable: false });
  const s2 = createState();
  const r2 = await apply({ settings: notWritable.settings }, configWith(captureFetch(() => jsonResponse(SEEDED)).fetchImpl), s2);
  check("profile 不可写：失败且带 documentPath", r2.ok === false && !r2.ok && r2.error.includes("not writable") && r2.error.includes(DOCUMENT_PATH), r2.ok ? "" : r2.error);
  check("profile 不可写：没有写入", notWritable.writes.length === 0);

  const s3 = createState();
  const r3 = await apply({}, configWith(captureFetch(() => jsonResponse(SEEDED)).fetchImpl), s3);
  check("ctx 没有 settings：失败并说明", r3.ok === false && !r3.ok && r3.error.includes("no settings service"), r3.ok ? "" : r3.error);
}

// ── 13. 地址解析（dsh 侧的三级）────────────────────────────────────────

console.log("resolveDshGateway");

{
  const fromConfig = resolveDshGateway({ gateway: "http://cfg:6450", env: { DSH_FACADE_GATEWAY: "http://env:1" } });
  check("插件配置最高优先", fromConfig.ok && fromConfig.from === "plugin config" && fromConfig.gateway === "http://cfg:6450");

  const fromEnv = resolveDshGateway({ env: { DSH_FACADE_GATEWAY: "http://env:1", FACADE_GATEWAY: "http://facade:2" } });
  check("其次 DSH_FACADE_GATEWAY", fromEnv.ok && fromEnv.from === "DSH_FACADE_GATEWAY" && fromEnv.gateway === "http://env:1");

  const fromFallback = resolveDshGateway({ env: {} });
  check("都没有时用默认地址", fromFallback.ok && fromFallback.from === "default" && fromFallback.gateway === DEFAULT_GATEWAY);

  const broken = resolveDshGateway({ env: { DSH_FACADE_GATEWAY: "not-a-url" } });
  check("写错的地址：报错，不悄悄换成默认值", !broken.ok && broken.error.includes("not an http(s) URL"));

  check("启动等待预算是 2 秒（启动路径上被 await）", DEFAULT_TIMEOUT_MS === 2000);
}

// ── 14. 红线：源码里没有任何文件写路径 ──────────────────────────────────

console.log("红线扫描（源码不写文件、不碰 configEditor）");

{
  const files = ["index.ts", "provider.ts", "settings-sync.ts", "gateway-source.ts"];
  for (const name of files) {
    const source = fs.readFileSync(path.join(HERE, "..", name), "utf8");
    const importsFs = /from\s+"node:(fs|path|os)"/.test(source);
    const writesFiles = /\b(writeFile|appendFile|createWriteStream|writeFileSync|renameSync|rename\()/.test(source);
    check(`${name}：不 import 文件系统写路径`, !importsFs && !writesFiles, importsFs ? "imports fs" : writesFiles ? "calls a write API" : "");
    check(`${name}：不碰 configEditor`, !source.includes("configEditor"));
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
