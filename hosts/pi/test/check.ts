// test/check.ts — pi-agentfacade 的自检。
//
//   cd hosts/pi && node --experimental-strip-types test/check.ts
//
// 覆盖五块：
//   · 字段映射：ModelSpec[] → pi 的 provider 配置。输入面是下面手写的 SPECS（17 条），
//     期望值写在 fixtures/expected.ts 里 —— 手写快照，不由任何程序生成。
//     网关报文长什么样不在这层：那是 core 的事，形状只留一份。
//   · 网关地址解析：PI_FACADE_GATEWAY > FACADE_GATEWAY > 配置文件
//   · 真实网络：起一个 127.0.0.1 的假网关（startFakeUpstream），走真的 fetch；
//     可达时注册的模型数等于 /v1/models 的 data 长度，不可达时**不注册**且不抛
//   · 刷新与命令：refreshModels 重新拉、拉不到时交回上一次的清单而不是空数组、
//     /facade-models 显示的几个数字
//   · session-affinity 头：真的 pi-ai stream 打本地假上游 —— compat 旗子要真的到得了
//     请求头才算数（配置对象上的断言不是证据）
//
// 全部离线：假网关在本机、清单是手写的 ModelSpec，不碰真网关也不花额度。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import facadeModels, { describe, refresh, type PiExtensionApi, type PluginOptions, type RefreshModels } from "../index.ts";
import {
  effectiveEfforts,
  levelMap,
  toPiModelEntry,
  toProviderConfig,
  type PiModelEntry,
  type PiProviderConfig,
} from "../catalog.ts";
import { fetchModelList, modelsUrl } from "../../../core/gateway.ts";
import type { PollerTimers } from "../../../core/poll.ts";
import type { ModelSpec } from "../../../core/types.ts";
import { resolveGateway } from "../gateway-config.ts";
import { EXPECTED as EXPECTED_SNAPSHOT } from "../fixtures/expected.ts";
import {
	createParentSessionIdResolver,
	readFirstLineSync,
	type AgentStartEvent,
	type HookContextLike,
	type ProviderHeaderEvent,
} from "../session-headers.ts";
import { startFakeUpstream, type CapturedRequest } from "./fake-upstream.ts";

// 线上用例的对象：真的 pi-ai（1.5.2，与 pi 同版钉死）的 anthropic-messages 适配器。
// 只走导出表（./api/*、./utils/*、根 ./ 的类型）；pi-ai 的 package.json 没在导出表里，不许 import。
import { stream, streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { Model } from "@earendil-works/pi-ai";
const EXPECTED = EXPECTED_SNAPSHOT;

/**
 * 一条 ModelSpec 的构造器：只写这条用例关心的字段，其余按「网关没报」的默认值。
 *
 * 默认值不是断言（下面每处断言仍然逐字写出期望结果）；它存在的理由只是 ModelSpec 有
 * 八格，而一条用例通常只关心其中两三格。
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
 * 快照用例的输入：17 条 ModelSpec —— **agent 的输入**，不是网关的报文。
 *
 * 为什么不放一份录制：agent 的职责是「ModelSpec → agent 配置」。网关报文的形状只该有一份
 * （在 core 的测试里）；agent 测试再抄一份，网关换个渲染这一层就得跟着改，而它一个字段
 * 都没变。这里要覆盖的是**映射真正处理的形状**：`off` 单独一档、四档齐全、四档齐全但
 * 夹着 `default` 与 `xhigh`、`none`、拼错的 `midium`、以及窗口/输出上限各不相同的那些。
 *
 * 三个新字段按「这一版网关没报」写：`toolCall` 照录制（model-09/10 是 false，pi 不用
 * 它），`modalities` 与 `cost` 是 null。`cost: null` 走「没报价」那条分支，所以快照里的
 * 价格全是 0 —— 有价格的用例单独列在下面。
 */
const SPECS: ModelSpec[] = [
  spec({ id: "model-01", displayName: "Model 01", efforts: ["off", "low", "high", "max"], contextWindow: 1000000, maxOutputTokens: 384000 }),
  spec({ id: "model-02", displayName: "Model 02", efforts: ["off", "default", "low", "medium", "high", "xhigh", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "model-03", displayName: "Model 03", efforts: ["off", "low", "high", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "model-04", displayName: "Model 04", efforts: ["off", "none", "high"], contextWindow: 1048576, maxOutputTokens: 65536 }),
  // "midium" 是上游真实拼写：原样进 levelMap（收敛规则自己决定它映到哪）
  spec({ id: "model-05", displayName: "Model 05", efforts: ["off", "low", "midium", "high"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "model-06", displayName: "Model 06", efforts: ["off", "low", "high", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "model-07", displayName: "Model 07", efforts: ["off", "low", "high", "max"], contextWindow: 1000000, maxOutputTokens: 384000 }),
  spec({ id: "model-08", displayName: "Model 08", efforts: ["off", "default", "low", "medium", "high", "xhigh", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  // toolCall=false 的模型在 pi 侧没有任何差别（pi 这一侧不表达能不能调工具）
  spec({ id: "model-09", displayName: "Model 09", efforts: ["off", "low", "high"], contextWindow: 131072, maxOutputTokens: 32768, toolCall: false }),
  spec({ id: "model-10", displayName: "Model 10", efforts: ["off", "low", "high"], contextWindow: 131072, maxOutputTokens: 65536, toolCall: false }),
  spec({ id: "model-11", displayName: "Model 11", efforts: ["off", "default", "low", "medium", "high", "xhigh", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "model-12", displayName: "Model 12", efforts: ["off", "none", "high"], contextWindow: 1048576, maxOutputTokens: 65536 }),
  spec({ id: "model-13", displayName: "Model 13", efforts: ["off", "low", "high", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "model-14", displayName: "Model 14", efforts: ["off"], contextWindow: 1000000, maxOutputTokens: 262144 }),
  spec({ id: "model-15", displayName: "Model 15", efforts: ["off", "low", "midium", "high"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "model-16", displayName: "Model 16", efforts: ["off", "low", "high", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "model-17", displayName: "Model 17", efforts: ["off", "low", "high", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
];

/**
 * 假网关的响应体：**只有 id**。
 *
 * agent 的义务到 ModelSpec 为止；条目里其余字段长什么样是 core 的事（形状只留一份），
 * 这样网关改渲染时这一层不会被拖下水。这些用例需要的只是「有 N 条能过 core 的清单」。
 */
const LISTED = { data: SPECS.map(({ id }) => ({ id })) };

/**
 * 请求打到的是不是模型清单那一路。
 *
 * 只看路径：清单地址上挂什么方言（`?dialect=` 之类）是 core 的事，agent 这一层不该知道。
 * 写死整条 URL 会让 core 换个方言这一层就红 —— 那不是 agent 的行为变了。
 */
function isModelsPath(url: string): boolean {
  return url.split("?")[0] === "/v1/models";
}

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

/** 临时主目录：配置文件的回落到这里读，绝不读真实 ~/.config */
function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-models-home-"));
}

// ── 档位映射 ─────────────────────────────────────────────────────────────
// 每一条的期望值都手写在这份测试里：改映射就要改它们

console.log("levelMap（期望值手写）");

check(
  "off+low+high+max：往下取，xhigh 映 high",
  same(levelMap(["off", "low", "high", "max"]), {
    off: "off",
    minimal: "low",
    low: "low",
    medium: "low",
    high: "high",
    xhigh: "high",
    max: "max",
  }),
  JSON.stringify(levelMap(["off", "low", "high", "max"])),
);

check(
  "只有 off：每个 pi 档位都映 off（pi 靠 map.off !== null 才允许关思考）",
  same(levelMap(["off"]), {
    off: "off",
    minimal: "off",
    low: "off",
    medium: "off",
    high: "off",
    xhigh: "off",
    max: "off",
  }),
  JSON.stringify(levelMap(["off"])),
);

check(
  "未知档位（none）不掉：max 映到它，低档往上取到 high",
  same(levelMap(["off", "none", "high"]), {
    off: "off",
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "high",
    max: "none",
  }),
  JSON.stringify(levelMap(["off", "none", "high"])),
);

check(
  "拼错的档位（midium，真网关就这么发）照样映到它",
  same(levelMap(["off", "low", "midium", "high"]), {
    off: "off",
    minimal: "low",
    low: "low",
    medium: "low",
    high: "high",
    xhigh: "high",
    max: "midium",
  }),
  JSON.stringify(levelMap(["off", "low", "midium", "high"])),
);

check(
  "四档齐全（low/medium/high/max）走定表：off 与 minimal 是 null",
  same(levelMap(["low", "medium", "high", "max"]), {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "max",
  }),
  JSON.stringify(levelMap(["low", "medium", "high", "max"])),
);

check(
  "没有档位（空数组）：每一格都是 null，关不掉思考",
  same(levelMap([]), {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  }),
  JSON.stringify(levelMap([])),
);

check(
  "没有 off 的模型 off 那格是 null",
  same(levelMap(["low", "high", "max"]), {
    off: null,
    minimal: "low",
    low: "low",
    medium: "low",
    high: "high",
    xhigh: "high",
    max: "max",
  }),
  JSON.stringify(levelMap(["low", "high", "max"])),
);

check(
  "带 default 的齐全集合：max 映到 default（看着像 bug，别顺手改）",
  levelMap(["off", "default", "low", "medium", "high", "xhigh", "max"]).max === "default",
  JSON.stringify(levelMap(["off", "default", "low", "medium", "high", "xhigh", "max"])),
);

check(
  "xhigh 那格落在 min/high 之间：off+minimal+max → 低档都映 minimal",
  same(levelMap(["off", "minimal", "max"]), {
    off: "off",
    minimal: "minimal",
    low: "minimal",
    medium: "minimal",
    high: "minimal",
    xhigh: "minimal",
    max: "max",
  }),
  JSON.stringify(levelMap(["off", "minimal", "max"])),
);

console.log("");
console.log("effectiveEfforts / toPiModelEntry");

check("没有档位 + reasoning=false → 只有 off", same(effectiveEfforts(null, false), ["off"]));
check("没有档位 + reasoning 不知道 → 什么都不给（关不掉思考）", same(effectiveEfforts(null, null), []));
check("有档位就照网关给的，不看 reasoning", same(effectiveEfforts(["off", "high"], false), ["off", "high"]));

{
  const noThinking = toPiModelEntry(spec({ id: "flat", displayName: "Flat", reasoning: false }));
  check("reasoning=false 的模型 reasoning 写 false", noThinking.reasoning === false, String(noThinking.reasoning));
  check(
    "reasoning=false 且没有档位 → 每个 pi 档位都映 off",
    Object.values(noThinking.thinkingLevelMap).every((v) => v === "off"),
    JSON.stringify(noThinking.thinkingLevelMap),
  );
}

{
  // 档位阶梯是 agent 的事：这里只钉「spec.efforts 真的接到了 levelMap 上」（逐字）
  const mapped = toPiModelEntry(spec({ id: "m", efforts: ["off", "high"] }));
  check(
    "spec.efforts 接到 thinkingLevelMap（收敛规则在这一层）",
    same(mapped.thinkingLevelMap, {
      off: "off",
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "high",
      max: "high",
    }),
    JSON.stringify(mapped.thinkingLevelMap),
  );
}

{
  const entry = toPiModelEntry(spec({ id: "coder-a", displayName: "Coder A", contextWindow: 131072, maxOutputTokens: 32768 }));
  check("name 用 displayName（不是裸 id）", entry.name === "Coder A" && entry.name !== entry.id, `${entry.id} → ${entry.name}`);
  check(
    "窗口与输出上限原样搬（200000 / 4096 的缺省值由 core 补，这里不重算）",
    entry.contextWindow === 131072 && entry.maxTokens === 32768,
    `${entry.contextWindow}/${entry.maxTokens}`,
  );
  check("input 固定 text+image（pi 的模型定义只认这两项）", same(entry.input, ["text", "image"]), JSON.stringify(entry.input));
}

console.log("");
console.log("cost（网关「每百万 token、美元」→ pi 的四格）");

{
  const priced = toPiModelEntry(spec({ id: "priced", cost: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 } }));
  check(
    "有报价：三侧原样搬到 cost.input / output / cacheRead",
    same(priced.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }),
    JSON.stringify(priced.cost),
  );
  check("写缓存价恒为 0（网关不报这一项，宁可少算不虚报）", priced.cost.cacheWrite === 0, String(priced.cost.cacheWrite));
}

{
  // 网关没报价 → 全 0。这是 pi 的成本统计口径（它没有「未知价格」这个状态），不是我们的断言
  const unpriced = toPiModelEntry(spec({ id: "unpriced", cost: null }));
  check(
    "cost === null（网关没报价）→ 四格全 0",
    same(unpriced.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify(unpriced.cost),
  );
  check(
    "cost 这一格永远存在（pi 的 calculateCost 读 model.cost.tiers，缺了第一个 SSE 事件就抛）",
    Object.hasOwn(unpriced, "cost"),
    JSON.stringify(Object.keys(unpriced)),
  );
}

{
  const outputOnly = toPiModelEntry(spec({ id: "output-only", cost: { outputPerMillion: 15 } }));
  check(
    "只报输出价：那一侧有价，没报的侧是 0（四格必须齐）",
    same(outputOnly.cost, { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify(outputOnly.cost),
  );
}

{
  // 0 元是**有**报价：判断用 ?? 而不是真值，否则「报了 0」与「没报」会走上同一条错路
  const free = toPiModelEntry(spec({ id: "free", cost: { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 } }));
  check(
    "报 0 元：落到 0（不被当成「没报价」丢掉这一格）",
    same(free.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify(free.cost),
  );
}

// ── 整份配置的快照比对 ────────────────────────────────────────────────

console.log("");
console.log("整份 provider 配置");

const fromSpecs = SPECS.map(toPiModelEntry);
check("快照的输入面是 17 条 ModelSpec", fromSpecs.length === 17, String(fromSpecs.length));
check(
  "provider 配置与 fixtures/expected.ts 手写快照逐字相同",
  same(toProviderConfig("http://gateway.example:6450", "public", fromSpecs), EXPECTED),
  JSON.stringify(toProviderConfig("http://gateway.example:6450", "public", fromSpecs)).slice(0, 200),
);
check(
  "每条模型都带 cost 与 compat（缺任一项 pi 在第一个 SSE 事件上就抛）",
  fromSpecs.every((m) => Object.hasOwn(m, "cost") && m.compat.forceAdaptiveThinking && m.compat.sendSessionAffinityHeaders),
  JSON.stringify(fromSpecs[0]),
);

// ── 网关地址解析 ─────────────────────────────────────────────────────────

console.log("");
console.log("resolveGateway（优先级：PI_FACADE_GATEWAY → FACADE_GATEWAY → 配置文件 → 旧路径 → 默认）");

const home = tempHome();
fs.mkdirSync(path.join(home, ".config", "agentfacade"), { recursive: true });
fs.writeFileSync(path.join(home, ".config", "agentfacade", "config.json"), '{"gateway":"http://new-config.example:6450"}');
fs.mkdirSync(path.join(home, ".config", "buddy-helper"), { recursive: true });
fs.writeFileSync(path.join(home, ".config", "buddy-helper", "config.json"), '{"gateway":"http://from-config.example:6450/"}');

const both = resolveGateway({ PI_FACADE_GATEWAY: "http://pi.example:6450", FACADE_GATEWAY: "http://facade.example:6450" }, home);
check(
  "PI_FACADE_GATEWAY 赢过其它所有级（值与 from 都能和别的级区分）",
  both.ok && both.gateway === "http://pi.example:6450" && both.from === "PI_FACADE_GATEWAY",
  JSON.stringify(both),
);

const facade = resolveGateway({ FACADE_GATEWAY: "http://facade.example:6450" }, home);
check(
  "没有 PI_FACADE_GATEWAY 时 FACADE_GATEWAY 赢过两级配置文件",
  facade.ok && facade.gateway === "http://facade.example:6450" && facade.from === "FACADE_GATEWAY",
  JSON.stringify(facade),
);

const fromFile = resolveGateway({}, home);
check(
  "环境变量都空 → 读 ~/.config/agentfacade/config.json（三个 agent 共用那份）",
  fromFile.ok && fromFile.gateway === "http://new-config.example:6450" && fromFile.from === "config file",
  JSON.stringify(fromFile),
);

const legacyHome = tempHome();
fs.mkdirSync(path.join(legacyHome, ".config", "buddy-helper"), { recursive: true });
fs.writeFileSync(path.join(legacyHome, ".config", "buddy-helper", "config.json"), '{"gateway":"http://from-config.example:6450/"}');
const fromLegacy = resolveGateway({}, legacyHome);
check(
  "只有旧路径 → 读 buddy-helper，from 是 legacy config file，末尾斜杠去掉",
  fromLegacy.ok && fromLegacy.gateway === "http://from-config.example:6450" && fromLegacy.from === "legacy config file",
  JSON.stringify(fromLegacy),
);

const emptyHome = tempHome();
const nowhere = resolveGateway({}, emptyHome);
check(
  "哪里都没配 → 退到文档写的默认网关，插件开箱能用",
  nowhere.ok && nowhere.gateway === "http://127.0.0.1:6450" && nowhere.from === "default",
  JSON.stringify(nowhere),
);

const badScheme = resolveGateway({ PI_FACADE_GATEWAY: "ftp://nope" }, emptyHome);
check("不是 http(s) 地址 → 报错而不是拿去请求", !badScheme.ok && badScheme.error.includes("http(s)"), JSON.stringify(badScheme));

// 自己的那份严格：坏文件与坏类型都报错；旧文件宽容：坏文件当没配 —— 两条分开钉，别被「顺手统一」
const brokenConfigHome = tempHome();
fs.mkdirSync(path.join(brokenConfigHome, ".config", "agentfacade"), { recursive: true });
fs.writeFileSync(path.join(brokenConfigHome, ".config", "agentfacade", "config.json"), "{ not json");
const broken = resolveGateway({}, brokenConfigHome);
check(
  "自己的配置文件 JSON 坏 → 报错带文件路径与原因，不悄悄退默认",
  !broken.ok && broken.error.includes("agentfacade/config.json") && broken.error.includes("not valid JSON"),
  JSON.stringify(broken),
);

const wrongTypeHome = tempHome();
fs.mkdirSync(path.join(wrongTypeHome, ".config", "agentfacade"), { recursive: true });
fs.writeFileSync(path.join(wrongTypeHome, ".config", "agentfacade", "config.json"), '{"gateway":42}');
const wrongType = resolveGateway({}, wrongTypeHome);
check("gateway 不是字符串 → 报错带实际值", !wrongType.ok && wrongType.error.includes('"gateway"') && wrongType.error.includes("42"), JSON.stringify(wrongType));

const brokenLegacyHome = tempHome();
fs.mkdirSync(path.join(brokenLegacyHome, ".config", "buddy-helper"), { recursive: true });
fs.writeFileSync(path.join(brokenLegacyHome, ".config", "buddy-helper", "config.json"), "{ not json");
check(
  "旧配置文件坏了 → 当成没配，退到默认网关（历史行为，与新文件不同）",
  resolveGateway({}, brokenLegacyHome).ok,
  JSON.stringify(resolveGateway({}, brokenLegacyHome)),
);
// 方言（query）是 core 的事：这里只钉「清单走的是根路径下的 /v1/models」
check(
  "模型清单地址的路径是根路径下的 /v1/models",
  new URL(modelsUrl("http://gw.example:6450")).pathname === "/v1/models" &&
    new URL(modelsUrl("http://gw.example:6450")).origin === "http://gw.example:6450",
  modelsUrl("http://gw.example:6450"),
);

// ── 真实网络：可达与不可达 ──────────────────────────────────────────────

console.log("");
console.log("真实网络（127.0.0.1 的假网关，真的 fetch）");

interface Captured {
  provider: { name: string; config: PiProviderConfig & { refreshModels?: RefreshModels } } | null;
  /** 注册次数：轮询「变了才重新注册」要数它，不能只看最后一份配置 */
  registrations: Array<{ name: string; config: PiProviderConfig & { refreshModels?: RefreshModels } }>;
  command: { name: string; handler: (args: string, ctx: unknown) => Promise<void> } | null;
  /** /agentfacade 与别名 /facade-models 各注册一条；command 保留最后一条，旧用例不用改 */
  commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
  hooks: {
    beforeAgentStart?: (event: AgentStartEvent, ctx: HookContextLike) => void;
    beforeProviderHeaders?: (event: ProviderHeaderEvent, ctx: HookContextLike) => void;
  };
}

function fakePi(): PiExtensionApi & Captured {
  const captured: PiExtensionApi & Captured = {
    provider: null,
    registrations: [],
    command: null,
    commands: [],
    hooks: {},
    registerProvider(name, config) {
      captured.provider = { name, config };
      captured.registrations.push({ name, config });
    },
    registerCommand(name, options) {
      const entry = { name, handler: options.handler as (args: string, ctx: unknown) => Promise<void> };
      captured.commands.push(entry);
      captured.command = entry;
    },
    on(name, handler) {
      if (name === "before_agent_start") captured.hooks.beforeAgentStart = handler as (event: AgentStartEvent, ctx: HookContextLike) => void;
      if (name === "before_provider_headers") captured.hooks.beforeProviderHeaders = handler as (event: ProviderHeaderEvent, ctx: HookContextLike) => void;
    },
  } as PiExtensionApi & Captured;
  return captured;
}

function runFactory(env: Record<string, string>, home: string, extra: Partial<PluginOptions> = {}) {
  const pi = fakePi();
  const warnings: string[] = [];
  const options: PluginOptions = { env, home, warn: (m) => warnings.push(m), ...extra };
  return { pi, warnings, options };
}

const gateway = await startFakeUpstream((req) =>
  isModelsPath(req.url) ? { body: LISTED } : undefined,
);

{
  const { pi, warnings, options } = runFactory({ PI_FACADE_GATEWAY: gateway.url }, tempHome());
  await facadeModels(pi, options);

  const expected = EXPECTED.models.length;
  check("可达时注册了 provider agentfacade", pi.provider?.name === "agentfacade", JSON.stringify(pi.provider?.name));
  check(
    `注册的模型数等于 /v1/models 的 data 长度（${LISTED.data.length}）`,
    pi.provider?.config.models.length === LISTED.data.length && LISTED.data.length === expected,
    `${pi.provider?.config.models.length} vs ${LISTED.data.length}`,
  );
  check("baseUrl 是网关根地址（不带 /v1）", pi.provider?.config.baseUrl === gateway.url, String(pi.provider?.config.baseUrl));
  check("方言是 anthropic-messages", pi.provider?.config.api === "anthropic-messages", String(pi.provider?.config.api));
  // provider 级不写 compat（pi 的扩展注册路径不读它），每条模型上必须有，否则网关
  // 认不出会话（实测 502 MissingSessionID）
  check(
    "compat 两个标志在每条模型上",
    pi.provider!.config.models.every(
      (m) =>
        m.compat.forceAdaptiveThinking === true && m.compat.sendSessionAffinityHeaders === true,
    ),
    JSON.stringify(pi.provider!.config.models[0]?.compat),
  );
  check("注册了一个 refreshModels", typeof pi.provider?.config.refreshModels === "function");
  check("注册了 /facade-models 命令", pi.command?.name === "facade-models", String(pi.command?.name));
  check("可达时没有警告", warnings.length === 0, JSON.stringify(warnings));
  check(
    "打的是 /v1/models",
    gateway.requests.length === 1 && isModelsPath(gateway.requests[0].url),
    JSON.stringify(gateway.requests.map((r) => r.url)),
  );
}

{
  // 不可达：端口上没人听（fake 已经关掉自己挑的端口，这里换一个肯定空着的）
  const dead = await startFakeUpstream();
  const deadUrl = dead.url;
  await dead.close();

  const { pi, warnings, options } = runFactory({ PI_FACADE_GATEWAY: deadUrl }, tempHome());
  let threw = false;
  try {
    await facadeModels(pi, options);
  } catch {
    threw = true;
  }
  check("网关不可达时工厂不抛异常", !threw);
  check("网关不可达时**不注册**（空清单会把用户的模型清空）", pi.provider === null, JSON.stringify(pi.provider));
  check("不可达时仍然注册 /facade-models（让用户能自己刷新）", pi.command?.name === "facade-models");
  check(
    "警告里写明原因与「没注册」",
    warnings.some((w) => w.includes("not registering")),
    JSON.stringify(warnings),
  );
  // 反向：地址是用户显式给的，不该再劝「去设 PI_FACADE_GATEWAY」—— 那句 hint 只对
  // 「踩默认地址」成立。少了这条，守卫去掉以后全套测试仍然全绿
  check(
    "显式设了网关时警告不出现默认地址那句",
    !warnings.some((w) => w.includes("no gateway configured")),
    JSON.stringify(warnings),
  );
}

{
  // 一个 HTTP 200 但 data 是空的清单：同样不能注册
  const empty = await startFakeUpstream(() => ({ body: { data: [] } }));
  const { pi, warnings, options } = runFactory({ PI_FACADE_GATEWAY: empty.url }, tempHome());
  await facadeModels(pi, options);
  check("清单为空时不注册", pi.provider === null);
  check("清单为空时警告说明是空清单", warnings.some((w) => w.includes("no models")), JSON.stringify(warnings));
  await empty.close();
}

{
  // 网关答的不是 JSON（比如被面板/反向代理顶了一个 HTML 错误页）
  const html = await startFakeUpstream(() => ({ body: "<html>bad gateway</html>", headers: { "content-type": "text/html" } }));
  const listed = await fetchModelList(html.url);
  check("答的不是 JSON 时报「did not answer a JSON object」", !listed.ok && listed.error.includes("did not answer a JSON object"), JSON.stringify(listed));
  await html.close();

  const noData = await startFakeUpstream(() => ({ body: { object: "list" } }));
  const listed2 = await fetchModelList(noData.url);
  check("没有 data 那一格时报「no data list」而不是当成空清单", !listed2.ok && listed2.error.includes('no "data" list'), JSON.stringify(listed2));
  await noData.close();

  const http500 = await startFakeUpstream(() => ({ status: 500, body: { error: "boom" } }));
  const listed3 = await fetchModelList(http500.url);
  check("HTTP 500 报状态码", !listed3.ok && listed3.error.includes("HTTP 500"), JSON.stringify(listed3));
  await http500.close();
}

{
  // 什么都没配：试文档默认的网关。这里用注入的 fetch 让它失败，并记录被请求的
  // 地址 —— 断言不能靠本机恰好有没有跑网关，那会让用例在别人机器上飘
  const seen: string[] = [];
  const failingFetch = (async (input: string | URL | { toString(): string }) => {
    seen.push(String(input));
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  const { pi, warnings, options } = runFactory({}, tempHome(), { fetchOptions: { fetchImpl: failingFetch } });
  await facadeModels(pi, options);
  check(
    "什么都没配时去试默认网关 127.0.0.1:6450",
    seen.length === 1 && new URL(seen[0]).origin === "http://127.0.0.1:6450" && isModelsPath(new URL(seen[0]).pathname),
    JSON.stringify(seen),
  );
  check("默认网关连不上 → 不注册（models.json 继续生效）", pi.provider === null);
  check(
    "默认地址连不上时，警告里带地址与「怎么改」（环境变量名）",
    warnings.some((w) => w.includes("127.0.0.1:6450") && w.includes("not registering") && w.includes("PI_FACADE_GATEWAY")),
    JSON.stringify(warnings),
  );
}

// ── 超时 ────────────────────────────────────────────────────────────────

console.log("");
console.log("超时（注入一个永不响应的 fetch）");

{
  const hangFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const started = Date.now();
  const result = await fetchModelList("http://gw.example:6450", { timeoutMs: 150, fetchImpl: hangFetch });
  const elapsed = Date.now() - started;
  check("永不响应的网关按超时返回失败", !result.ok && result.error.includes("timed out"), JSON.stringify(result));
  check(`超时时间被遵守（${elapsed}ms，上限 150ms + 余量）`, elapsed >= 140 && elapsed < 800, `${elapsed}ms`);
}

{
  // 外层 signal 取消（pi 刷新目录时会给）
  const hangFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const result = await fetchModelList("http://gw.example:6450", { timeoutMs: 5000, fetchImpl: hangFetch, signal: controller.signal });
  check("pi 给的取消信号能提前结束拉取", !result.ok && result.error.includes("cancelled"), JSON.stringify(result));
  check("取消与失败分开报（cancelled 而不是超时）", !result.ok && result.cancelled === true, JSON.stringify(result));
}

// ── refreshModels 与命令 ────────────────────────────────────────────────

console.log("");
console.log("refreshModels 与 /facade-models");

{
  let body: unknown = LISTED;
  const live = await startFakeUpstream(() => ({ body }));
  const { pi, warnings, options } = runFactory({ PI_FACADE_GATEWAY: live.url }, tempHome());
  await facadeModels(pi, options);

  const refreshModels = pi.provider!.config.refreshModels!;
  body = { data: LISTED.data.slice(0, 3) };
  const after = await refreshModels({});
  check("refreshModels 重新拉网关（清单变短也跟着变）", after.length === 3, String(after.length));
  check(
    "refreshModels 把新清单也写进了 provider 状态",
    after[0]?.id === LISTED.data[0].id && after.every((m) => m.id !== LISTED.data[3].id),
    `${after[0]?.id} … ${after.map((m) => m.id).join(",")}`,
  );

  // 网关这次回空清单：绝不能拿空清单去替换（legacy 形式的返回值是整条替换，
  // 交回 [] 就是把用户的模型清空）。必须退回上一份非空清单
  body = { data: [] };
  const emptied = await refreshModels({});
  check(
    "网关回空清单时交回上一份，而不是空数组",
    emptied.length === 3 && emptied[0]?.id === LISTED.data[0].id,
    `${emptied.length} 条`,
  );
  check(
    "网关回空清单时报告失败原因",
    warnings.some((w) => w.includes("listed no models")),
    JSON.stringify(warnings),
  );

  // 拉不到时交回上一次的清单，而不是空数组
  await live.close();
  const stale = await refreshModels({});
  check("拉不到时交回上一次的清单", stale.length === 3, String(stale.length));
  check(
    "拉不到时留下警告",
    warnings.some((w) => w.includes("refresh failed")),
    JSON.stringify(warnings),
  );
}

{
  // pi 每次注册/凭据变化都会重刷 provider，新的刷新会把旧的那次 abort。
  // 这种取消不能当成「网关出错」，否则每次正常启动都会多一条吓人的警告
  const live = await startFakeUpstream(() => ({ body: LISTED }));
  const { pi, warnings, options } = runFactory({ PI_FACADE_GATEWAY: live.url }, tempHome());
  await facadeModels(pi, options);
  const before = warnings.length;

  const controller = new AbortController();
  controller.abort();
  const entries = await pi.provider!.config.refreshModels!({ signal: controller.signal });
  check("被 pi 取消的刷新交回上一份清单", entries.length === LISTED.data.length, String(entries.length));
  check("被 pi 取消的刷新不报警告", warnings.length === before, JSON.stringify(warnings.slice(before)));
  await live.close();
}

{
  const live = await startFakeUpstream((req) => (isModelsPath(req.url) ? { body: LISTED } : undefined));
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: live.url }, tempHome());
  await facadeModels(pi, options);

  const seen: string[] = [];
  const ctx = { ui: { notify: (text: string) => seen.push(text) } };
  await pi.command!.handler("", ctx);
  const text = seen.join("\n");
  check("命令显示注册了多少条模型", text.includes(`${LISTED.data.length} registered`), text);
  check("命令显示网关地址与来源", text.includes(live.url) && text.includes("PI_FACADE_GATEWAY"), text);
  check("命令显示最后一次刷新时间", /Last refresh: \d{4}-/.test(text), text);
  await live.close();
}

{
  // 启动时拉不到，之后 /facade-models refresh 把 provider 补注册上
  let served: unknown = LISTED;
  const flaky = await startFakeUpstream((req) => (isModelsPath(req.url) ? { body: served } : undefined));
  const dead = await startFakeUpstream();
  const deadUrl = dead.url;
  await dead.close();

  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: deadUrl }, tempHome());
  await facadeModels(pi, options);
  check("（前置）启动时确实没注册", pi.provider === null);

  // 同一个扩展实例，把网关指向活的假上游：refresh 要用同一份 env 对象，
  // 所以这里换 env 而不是换实例
  options.env!.PI_FACADE_GATEWAY = flaky.url;
  const seen: string[] = [];
  await pi.command!.handler("refresh", { ui: { notify: (t: string) => seen.push(t) } });
  check("refresh 之后补注册了 provider", pi.provider?.name === "agentfacade", JSON.stringify(pi.provider?.name));
  check(
    "refresh 之后命令报告已注册",
    seen.join("\n").includes(`${LISTED.data.length} registered`),
    seen.join("\n"),
  );

  // 再刷一次，这次网关回空清单：不许拿空清单重新注册（legacy 的返回值是整条替换）
  served = { data: [] };
  seen.length = 0;
  await pi.command!.handler("refresh", { ui: { notify: (t: string) => seen.push(t) } });
  check(
    "网关回空清单时 refresh 不拿空清单重注册，provider 还是原来那些模型",
    pi.provider?.config.models.length === LISTED.data.length,
    `${pi.provider?.config.models.length} 条`,
  );
  check(
    "网关回空清单时命令把那句失败原因摆出来",
    seen.join("\n").includes("listed no models"),
    seen.join("\n"),
  );
  await flaky.close();
}

// ── 地址非法：工厂不注册、给一条带原因的警告 ────────────────────────────

{
  const { pi, warnings, options } = runFactory({ PI_FACADE_GATEWAY: "ftp://nope" }, tempHome());
  await facadeModels(pi, options);
  check("地址不是 http(s) 时工厂不注册", pi.provider === null);
  check(
    "地址不是 http(s) 时警告点名是哪个变量写错了",
    warnings.some((w) => w.includes("PI_FACADE_GATEWAY") && w.includes("http(s)")),
    JSON.stringify(warnings),
  );
  check("地址非法时仍然注册了 /facade-models 好让用户能修", pi.command?.name === "facade-models", String(pi.command?.name));
}

// ── state 的显示（未注册那一路） ────────────────────────────────────────

{
  const state = { gateway: "", from: "", models: [], lastRefresh: null, lastError: "boom", registered: false, apiKey: "" };
  const lines = describe(state).join("\n");
  check("未注册时 describe 说 NOT registered 并给下一步", lines.includes("NOT registered") && lines.includes("/agentfacade refresh"), lines);

  const okState = { gateway: "http://gw.example:6450", from: "config file", models: [toPiModelEntry(spec({ id: "a" }))], lastRefresh: Date.now(), lastError: null, registered: true, apiKey: "" };
  check("已注册时 describe 报模型数与网关", describe(okState).join("\n").includes("1 registered"), describe(okState).join("\n"));
}

// ── refresh() 在成功后会清掉上一次的错误 ────────────────────────────────

{
  const live = await startFakeUpstream(() => ({ body: LISTED }));
  const state = { gateway: "", from: "", models: [] as PiModelEntry[], lastRefresh: null as number | null, lastError: "old failure" as string | null, registered: false, apiKey: "" };
  const result = await refresh(state, { env: { PI_FACADE_GATEWAY: live.url }, home: tempHome() });
  check("refresh 成功后清掉 lastError", result.ok && state.lastError === null, JSON.stringify(state.lastError));
  check("refresh 成功后记下时间戳", state.lastRefresh !== null);

  // 取消不应该被记成错误（也不能清掉上一次的真实错误以外的东西）
  const controller = new AbortController();
  controller.abort();
  const cancelled = await refresh(state, { env: { PI_FACADE_GATEWAY: live.url }, home: tempHome() }, controller.signal);
  check("取消时 refresh 报 cancelled 而不是失败", !cancelled.ok && cancelled.cancelled === true, JSON.stringify(cancelled));
  check("取消时不动 lastError", state.lastError === null, JSON.stringify(state.lastError));
  await live.close();
}
// ── /agentfacade 与 /agentfacade connect ────────────────────────────────

console.log("");
console.log("/agentfacade 与 /agentfacade connect");

{
  const live = await startFakeUpstream((req) => (isModelsPath(req.url) ? { body: LISTED } : undefined));
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: live.url }, tempHome());
  await facadeModels(pi, options);
  check(
    "注册了 /agentfacade 与别名 /facade-models，同一个 handler",
    same(pi.commands.map((c) => c.name), ["agentfacade", "facade-models"]) && pi.commands[0].handler === pi.commands[1].handler,
    JSON.stringify(pi.commands.map((c) => c.name)),
  );

  // 归一化：不带 scheme 的地址写进配置文件的是补全后的形式
  const home = options.home!;
  const seen: string[] = [];
  await pi.command!.handler("connect 192.168.1.9", { ui: { notify: (t: string) => seen.push(t) } });
  const file = path.join(home, ".config", "agentfacade", "config.json");
  check(
    "connect 把归一化后的地址写进 ~/.config/agentfacade/config.json",
    fs.readFileSync(file, "utf8") === '{\n  "gateway": "http://192.168.1.9:6450"\n}\n',
    JSON.stringify(fs.readFileSync(file, "utf8")),
  );
  check("connect 报告写到了哪个文件", seen.join("\n").includes("gateway written to") && seen.join("\n").includes("config.json"), seen.join("\n"));
  check("connect 报告写到了哪个文件", seen.join("\n").includes("gateway written to") && seen.join("\n").includes("config.json"), seen.join("\n"));
  // env 变量还设着：优先级高于配置文件，所以刷新显示的来源仍是 env 这一级 —— 文件静静等 env 清掉的那天
  check(
    "写完刷新显示当前地址与来源（env 还设着，所以地址与来源都还是 env 那个）",
    seen.join("\n").includes(live.url) && seen.join("\n").includes("(from PI_FACADE_GATEWAY)"),
    seen.join("\n"),
  );
  await live.close();
}

{
  // connect 的核心闭环：启动时踩默认地址没注册，connect 到一个活的网关后立即刷新并补注册
  const live = await startFakeUpstream((req) => (isModelsPath(req.url) ? { body: LISTED } : undefined));
  // 路由型假 fetch：打到 connect 写入的那个地址才回清单，其它（默认地址）一律拒绝
  const routed = (async (input: unknown) => {
    const url = String(input);
    if (new URL(url).origin === live.url) {
      return new Response(JSON.stringify(LISTED), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  const { pi, options } = runFactory({}, tempHome(), { fetchOptions: { fetchImpl: routed } });
  await facadeModels(pi, options);
  check("（前置）启动时默认地址不可达，没有注册", pi.provider === null, JSON.stringify(pi.provider));

  const seen: string[] = [];
  await pi.command!.handler(`connect ${live.url}`, { ui: { notify: (t: string) => seen.push(t) } });
  check(
    "connect 写入的文件就是刷新用的地址：立即补注册了 provider",
    pi.provider?.name === "agentfacade" && pi.provider.config.baseUrl === live.url,
    JSON.stringify({ provider: pi.provider?.name, baseUrl: pi.provider?.config.baseUrl }),
  );
  check("补注册后模型数等于 /v1/models 的 data 长度", pi.provider?.config.models.length === LISTED.data.length, String(pi.provider?.config.models.length));
  check("刷新输出说明地址来自 config file 一级", seen.join("\n").includes("(from config file)"), seen.join("\n"));
  await live.close();
}

{
  // 写失败：home 的 .config 被普通文件挡住。报错且内存里的地址原样不动
  const live = await startFakeUpstream((req) => (isModelsPath(req.url) ? { body: LISTED } : undefined));
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: live.url }, tempHome());
  await facadeModels(pi, options);
  const home = options.home!;
  fs.writeFileSync(path.join(home, ".config"), "not a directory");

  const seen: string[] = [];
  await pi.command!.handler("connect 192.168.1.9", { ui: { notify: (t: string) => seen.push(t) } });
  check("写失败时报告原因（cannot write）", seen.join("\n").includes("cannot write"), seen.join("\n"));
  check("写失败时不报「written to」", !seen.join("\n").includes("gateway written to"), seen.join("\n"));

  seen.length = 0;
  await pi.command!.handler("", { ui: { notify: (t: string) => seen.push(t) } });
  check(
    "写失败后内存里的地址不变：还是 env 那个（不是 connect 想写的那个）",
    seen.join("\n").includes(live.url) && seen.join("\n").includes("PI_FACADE_GATEWAY") && !seen.join("\n").includes("192.168.1.9"),
    seen.join("\n"),
  );
  await live.close();
}

{
  // 归一化拒绝的地址：报错、不写文件、不刷新
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: "http://ok.example:6450" }, tempHome());
  await facadeModels(pi, options);
  const seen: string[] = [];
  await pi.command!.handler("connect ftp://nope", { ui: { notify: (t: string) => seen.push(t) } });
  check("非 http(s) → 报错点名原因并说明什么都没写", seen.join("\n").includes("only http(s)") && seen.join("\n").includes("nothing written"), seen.join("\n"));
  check(
    "拒绝时配置文件不存在",
    fs.existsSync(path.join(options.home!, ".config", "agentfacade", "config.json")) === false,
    String(fs.existsSync(path.join(options.home!, ".config", "agentfacade"))),
  );

  seen.length = 0;
  await pi.command!.handler("connect", { ui: { notify: (t: string) => seen.push(t) } });
  check("connect 不带地址 → 提示用法", seen.join("\n").includes("usage:"), seen.join("\n"));
}


// ── 密钥与轮询：pi 侧新行为 ──────────────────────────────────────────────
console.log("");
console.log("密钥与轮询（注塑 fetch / 假时钟，全部离线）");

const MOCK_GATEWAY = "http://pi-gw.example:6450";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

interface CapturedFetch {
  fetchImpl: typeof fetch;
  headers: Array<Record<string, string> | undefined>;
}
function authFetch(respond: () => Response | Promise<Response>): CapturedFetch {
  const headers: Array<Record<string, string> | undefined> = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    headers.push(init?.headers as Record<string, string> | undefined);
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, headers };
}

interface FakeTimer {
  handler: () => void;
  ms: number;
  unrefHits: number;
}
interface FakeClock {
  timers: PollerTimers;
  scheduled: FakeTimer[];
  /** 触发下一轮；tick 是 async，等一轮宏任务让 refresh/apply 与下一次排钟都落定 */
  fire(): Promise<void>;
}
function fakeClock(): FakeClock {
  const scheduled: FakeTimer[] = [];
  const pending: Array<{ timer: FakeTimer; handle: { unref(): void } }> = [];
  const timers: PollerTimers = {
    set(handler, ms) {
      const timer: FakeTimer = { handler, ms, unrefHits: 0 };
      const handle = {
        unref() {
          timer.unrefHits++;
        },
      };
      scheduled.push(timer);
      pending.push({ timer, handle });
      return handle;
    },
    clear(handle) {
      const index = pending.findIndex((entry) => entry.handle === handle);
      if (index >= 0) {
        scheduled.splice(scheduled.indexOf(pending[index].timer), 1);
        pending.splice(index, 1);
      }
    },
  };
  return {
    timers,
    scheduled,
    async fire() {
      const entry = pending.shift();
      if (!entry) throw new Error("no pending timer");
      scheduled.splice(scheduled.indexOf(entry.timer), 1);
      entry.timer.handler();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function seedAuth(home: string, body: string): void {
  const dir = path.join(home, ".config", "agentfacade");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "auth.json"), body);
}
function runMocked(env: Record<string, string>, home: string, fetchImpl: typeof fetch, extra: Partial<PluginOptions> = {}) {
  return runFactory(env, home, { fetchOptions: { fetchImpl }, ...extra });
}

{
  const token = "sk-pi-env-9f2a";
  const feed = authFetch(() => jsonResponse(LISTED));
  const { pi, options } = runMocked({ PI_FACADE_GATEWAY: MOCK_GATEWAY, PI_FACADE_API_KEY: token }, tempHome(), feed.fetchImpl);
  await facadeModels(pi, options);
  check("PI_FACADE_API_KEY → provider 配置的 apiKey 逐字等于它", pi.provider?.config.apiKey === token, JSON.stringify(pi.provider?.config.apiKey));
  check(
    "环境变量密钥 → 目录请求头逐字是 Bearer <key>",
    same(feed.headers, [{ accept: "application/json", authorization: `Bearer ${token}` }]),
    JSON.stringify(feed.headers),
  );
}

{
  const feed = authFetch(() => jsonResponse(LISTED));
  const { pi, options } = runMocked({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, tempHome(), feed.fetchImpl);
  await facadeModels(pi, options);
  check("没有密钥 → provider 配置的 apiKey 是 public", pi.provider?.config.apiKey === "public", JSON.stringify(pi.provider?.config.apiKey));
  check("没有密钥 → 请求头只有 accept，不带 authorization", same(feed.headers, [{ accept: "application/json" }]), JSON.stringify(feed.headers));
  const seen: string[] = [];
  await pi.command!.handler("", { ui: { notify: (t: string) => seen.push(t) } });
  check("describe 明说没密钥是网关 public 模式", seen.join("\n").includes("API key: none (gateway public mode)"), seen.join("\n"));
}

{
  const home = tempHome();
  seedAuth(home, JSON.stringify({ agentfacade: { type: "api_key", key: "sk-pi-file-4b7e" } }));
  const feed = authFetch(() => jsonResponse(LISTED));
  const { pi, options } = runMocked({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, home, feed.fetchImpl);
  await facadeModels(pi, options);
  check("只有 auth.json 有密钥 → 注册配置用的是文件里的值", pi.provider?.config.apiKey === "sk-pi-file-4b7e", JSON.stringify(pi.provider?.config.apiKey));
  check(
    "文件密钥 → 请求头带 Bearer <file key>",
    same(feed.headers, [{ accept: "application/json", authorization: "Bearer sk-pi-file-4b7e" }]),
    JSON.stringify(feed.headers),
  );
}

{
  // 坏文件只报告、不中断：密钥坏了不该连带模型同步一起停
  const home = tempHome();
  seedAuth(home, "{ not json");
  const feed = authFetch(() => jsonResponse(LISTED));
  const { pi, warnings, options } = runMocked({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, home, feed.fetchImpl);
  await facadeModels(pi, options);
  check(
    "坏 auth.json → 恰好一条警告说明忽略存下的密钥",
    warnings.length === 1 && warnings[0].includes("ignoring the stored api key"),
    JSON.stringify(warnings),
  );
  check(
    "坏 auth.json → 仍以 public 注册，模型没少",
    pi.provider?.config.apiKey === "public" && pi.provider.config.models.length === LISTED.data.length,
    JSON.stringify({ key: pi.provider?.config.apiKey, models: pi.provider?.config.models.length }),
  );
}

{
  const home = tempHome();
  const token = "sk-pi-command-6d31";
  const feed = authFetch(() => jsonResponse(LISTED));
  const { pi, warnings, options } = runMocked({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, home, feed.fetchImpl);
  await facadeModels(pi, options);
  const seen: string[] = [];
  await pi.command!.handler(`key ${token}`, { ui: { notify: (t: string) => seen.push(t) } });
  const file = path.join(home, ".config", "agentfacade", "auth.json");
  const content = fs.readFileSync(file, "utf8");
  check(
    "/key 写出的文件内容逐字（形状 + 两格缩进 + 换行）",
    content === `{\n  "agentfacade": {\n    "type": "api_key",\n    "key": "${token}"\n  }\n}\n`,
    JSON.stringify(content),
  );
  check("/key 写出的文件是 0600（明文密钥）", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  check(
    "/key 的输出与警告都不含 token",
    seen.join("\n").includes("api key saved") && seen.join("\n").includes("API key: set") && !seen.join("\n").includes(token) && !warnings.join("\n").includes(token),
    seen.join("\n"),
  );
  check(
    "/key 写完立刻用新密钥刷新（第二次请求才带 Bearer）",
    pi.provider?.config.apiKey === token &&
      same(feed.headers, [{ accept: "application/json" }, { accept: "application/json", authorization: `Bearer ${token}` }]),
    JSON.stringify(feed.headers),
  );
  seen.length = 0;
  await pi.command!.handler("key   ", { ui: { notify: (t: string) => seen.push(t) } });
  check(
    "/key 空 token → 用法提示且不改已存密钥",
    seen.join("\n").includes("usage: /agentfacade key <token>") && fs.readFileSync(file, "utf8") === content,
    seen.join("\n"),
  );
}

{
  const clock = fakeClock();
  const feed = authFetch(() => jsonResponse(LISTED));
  const { pi, options } = runMocked(
    { PI_FACADE_GATEWAY: MOCK_GATEWAY, PI_FACADE_REFRESH_MS: "45000", FACADE_REFRESH_MS: "99000" },
    tempHome(),
    feed.fetchImpl,
    { timers: clock.timers },
  );
  await facadeModels(pi, options);
  check(
    "轮询间隔来自 PI_FACADE_REFRESH_MS（不是共用变量或默认）",
    clock.scheduled.length === 1 && clock.scheduled[0].ms === 45000,
    JSON.stringify(clock.scheduled.map((t) => t.ms)),
  );
  check("挂钟时调了 unref（轮询不拦进程退出）", clock.scheduled[0]?.unrefHits === 1, JSON.stringify(clock.scheduled));
}

{
  let body: unknown = LISTED;
  const clock = fakeClock();
  const feed = authFetch(() => jsonResponse(body));
  const { pi, warnings, options } = runMocked({ PI_FACADE_GATEWAY: MOCK_GATEWAY, PI_FACADE_REFRESH_MS: "45000" }, tempHome(), feed.fetchImpl, {
    timers: clock.timers,
  });
  await facadeModels(pi, options);
  check("（前置）启动时注册一次", pi.registrations.length === 1, String(pi.registrations.length));
  await clock.fire();
  check("清单没变：拉了但不重新注册", feed.headers.length === 2 && pi.registrations.length === 1, JSON.stringify({ fetches: feed.headers.length, registrations: pi.registrations.length }));
  check("清单没变：仍挂下一轮", clock.scheduled.length === 1 && clock.scheduled[0].ms === 45000, JSON.stringify(clock.scheduled.map((t) => t.ms)));
  body = { data: LISTED.data.slice(0, 2) };
  await clock.fire();
  check("清单变了：重新注册一次", pi.registrations.length === 2, String(pi.registrations.length));
  check(
    "重新注册的配置装的是新清单（逐字两条 id）",
    same(pi.provider?.config.models.map((m) => m.id), LISTED.data.slice(0, 2).map((m) => m.id)),
    JSON.stringify(pi.provider?.config.models.map((m) => m.id)),
  );
  check("变化时有一行日志说明增减", warnings.some((w) => w.includes("model catalog changed")), JSON.stringify(warnings));
}

{
  // 轮询失败 = 保留上一份：失败不会把已注册的模型撤掉，也不停摆
  let reachable = true;
  const clock = fakeClock();
  const feed = authFetch(() => {
    if (!reachable) throw new TypeError("fetch failed");
    return jsonResponse(LISTED);
  });
  const { pi, options } = runMocked({ PI_FACADE_GATEWAY: MOCK_GATEWAY, PI_FACADE_REFRESH_MS: "45000" }, tempHome(), feed.fetchImpl, {
    timers: clock.timers,
  });
  await facadeModels(pi, options);
  reachable = false;
  await clock.fire();
  check(
    "轮询失败：不重新注册，上一份 provider 原样保留",
    pi.registrations.length === 1 && pi.provider?.config.models.length === LISTED.data.length,
    JSON.stringify({ registrations: pi.registrations.length, models: pi.provider?.config.models.length }),
  );
  check("轮询失败：下一轮照样挂上", clock.scheduled.length === 1, String(clock.scheduled.length));
}

// ── /agentfacade probe：只接线，分类留给 core ─────────────────────────────
console.log("");
console.log("/agentfacade probe（注入 fetch；表格逐字）");

const PROBE_CATALOG = { data: [{ id: "coder-a" }, { id: "coder-b" }] };
const PROBE_WARNING = "探活结果仅供参考，不是派单闸门：探活失败不等于用不了，成功也不保证这一次请求能成";

function probeReply(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 探活专用假 fetch：目录拉取走 fetchOptions.fetchImpl，这里只会收到 chat 请求 */
function probeFeed(respond: (model: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body });
    return respond(String((body as Record<string, unknown>).model ?? ""));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 延迟是实测值；快照里只把毫秒数归一，其余逐字 */
function probeLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\d+ms/, "Xms"));
}

{
  const catalog = authFetch(() => jsonResponse(PROBE_CATALOG));
  const feed = probeFeed((model) =>
    model === "coder-b" ? probeReply({ error: { message: "forbidden model" } }, 401) : probeReply({}),
  );
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, tempHome(), {
    fetchOptions: { fetchImpl: catalog.fetchImpl },
    probe: { fetchImpl: feed.impl },
  });
  await facadeModels(pi, options);
  const seen: string[] = [];
  await pi.command!.handler("probe", { ui: { notify: (text: string) => seen.push(text) } });

  check("不给参数时探 state.models 的 id（顺序逐字）", same(feed.calls.map((call) => (call.body as { model: string }).model), ["coder-a", "coder-b"]), JSON.stringify(feed.calls.map((call) => call.body)));
  check(
    "探活表逐字：四列 + 失败原因 + 末尾提示",
    same(probeLines(seen.join("\n")), [
      "探活 2 条模型，最坏约 15 秒",
      "模型 | 状态 | HTTP | 延迟",
      "coder-a | ok | 200 | Xms",
      "coder-b | auth | 401 | Xms",
      "coder-b: forbidden model",
      PROBE_WARNING,
    ]),
    JSON.stringify(probeLines(seen.join("\n"))),
  );
  check("提示是最后一行，且逐字是那句「不是闸门」", probeLines(seen.join("\n")).at(-1) === PROBE_WARNING && PROBE_WARNING.includes("不是派单闸门"), seen.join("\n"));
}

{
  const catalog = authFetch(() => jsonResponse(PROBE_CATALOG));
  const feed = probeFeed(() => probeReply({}));
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, tempHome(), {
    fetchOptions: { fetchImpl: catalog.fetchImpl },
    probe: { fetchImpl: feed.impl },
  });
  await facadeModels(pi, options);
  const seen: string[] = [];
  await pi.command!.handler("probe coder-z coder-a coder-z", { ui: { notify: (text: string) => seen.push(text) } });
  check(
    "指定名字时只探这些（core 去重、保持首次出现顺序）",
    same(feed.calls.map((call) => (call.body as { model: string }).model), ["coder-z", "coder-a"]),
    JSON.stringify(feed.calls.map((call) => call.body)),
  );
  check("表格行数跟着结果走（两条 + 表头 + 提示）", probeLines(seen.join("\n")).length === 5, JSON.stringify(probeLines(seen.join("\n"))));
  check("进度提示的模型数按去重后算（3 个名字只报 2 条）", probeLines(seen.join("\n"))[0] === "探活 2 条模型，最坏约 15 秒", JSON.stringify(probeLines(seen.join("\n"))[0]));
}

{
  const catalog = authFetch(() => jsonResponse(PROBE_CATALOG));
  const feed = probeFeed((model) => {
    if (model === "coder-a") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return probeReply({});
  });
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, tempHome(), {
    fetchOptions: { fetchImpl: catalog.fetchImpl },
    probe: { fetchImpl: feed.impl },
  });
  await facadeModels(pi, options);
  const seen: string[] = [];
  await pi.command!.handler("probe coder-a coder-b", { ui: { notify: (text: string) => seen.push(text) } });
  const lines = probeLines(seen.join("\n"));
  check("一条模型超时不中断整张表", same(lines.slice(1, 4), ["模型 | 状态 | HTTP | 延迟", "coder-a | timeout | - | Xms", "coder-b | ok | 200 | Xms"]), JSON.stringify(lines));
  check("失败行的原因也打印出来，提示仍在末尾", lines.includes("coder-a: aborted") && lines.at(-1) === PROBE_WARNING, JSON.stringify(lines));
}

{
  const token = "sk-probe-pi-9f2a";
  const catalog = authFetch(() => jsonResponse(PROBE_CATALOG));
  const feed = probeFeed(() => probeReply({ error: { message: `bad key ${token} accepted` } }, 401));
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: MOCK_GATEWAY, PI_FACADE_API_KEY: token }, tempHome(), {
    fetchOptions: { fetchImpl: catalog.fetchImpl },
    probe: { fetchImpl: feed.impl },
  });
  await facadeModels(pi, options);
  const seen: string[] = [];
  await pi.command!.handler("probe coder-a", { ui: { notify: (text: string) => seen.push(text) } });
  check("探活请求带 Bearer <key>", feed.calls[0].headers.authorization === `Bearer ${token}`, JSON.stringify(feed.calls[0].headers));
  check("错误体回显密钥时输出只出现 ***", !seen.join("\n").includes(token) && seen.join("\n").includes("bad key *** accepted"), seen.join("\n"));
}

{
  // 目录拉到空清单 → 不注册；此时探活不该对着空清单发请求，只给下一步
  const catalog = authFetch(() => jsonResponse({ data: [] }));
  const feed = probeFeed(() => probeReply({}));
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, tempHome(), {
    fetchOptions: { fetchImpl: catalog.fetchImpl },
    probe: { fetchImpl: feed.impl },
  });
  await facadeModels(pi, options);
  const seen: string[] = [];
  await pi.command!.handler("probe", { ui: { notify: (text: string) => seen.push(text) } });
  check("没有已注册模型时提示先 refresh 或给模型名", seen.join("\n").includes("先 /agentfacade refresh"), seen.join("\n"));
  check("没有已注册模型时不发探活请求", feed.calls.length === 0, String(feed.calls.length));
}

{
  const catalog = authFetch(() => jsonResponse(PROBE_CATALOG));
  const seen: string[] = [];
  let atFirstFetch: string[] = [];
  const feed = probeFeed(() => {
    atFirstFetch = [...seen];
    return probeReply({});
  });
  const { pi, options } = runFactory({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, tempHome(), {
    fetchOptions: { fetchImpl: catalog.fetchImpl },
    probe: { fetchImpl: feed.impl },
  });
  await facadeModels(pi, options);
  await pi.command!.handler("probe coder-a", { ui: { notify: (text: string) => seen.push(text) } });
  check("进度在第一个请求发出前就 notify：逐字", same(atFirstFetch, ["探活 1 条模型，最坏约 15 秒"]), JSON.stringify(atFirstFetch));
  check("结果在进度之后 notify", seen.length === 2 && seen[1].includes("coder-a | ok"), JSON.stringify(seen));
}

{
  for (const mode of ["signal", "getSignal"] as const) {
    const catalog = authFetch(() => jsonResponse(PROBE_CATALOG));
    const feed = probeFeed(() => probeReply({}));
    const { pi, options } = runFactory({ PI_FACADE_GATEWAY: MOCK_GATEWAY }, tempHome(), {
      fetchOptions: { fetchImpl: catalog.fetchImpl },
      probe: { fetchImpl: feed.impl },
    });
    await facadeModels(pi, options);
    const controller = new AbortController();
    controller.abort();
    const seen: string[] = [];
    const ctx =
      mode === "signal"
        ? { ui: { notify: (text: string) => seen.push(text) }, signal: controller.signal }
        : { ui: { notify: (text: string) => seen.push(text) }, getSignal: () => controller.signal };
    await pi.command!.handler("probe coder-a", ctx);
    check(
      `ctx.${mode} 的取消信号透传到 core：不发请求，逐字输出 cancelled`,
      feed.calls.length === 0 &&
        same(probeLines(seen.join("\n")), [
          "探活 1 条模型，最坏约 15 秒",
          "模型 | 状态 | HTTP | 延迟",
          "coder-a | cancelled | - | Xms",
          "coder-a: cancelled by caller",
          PROBE_WARNING,
        ]),
      JSON.stringify({ calls: feed.calls.length, lines: probeLines(seen.join("\n")) }),
    );
  }
}

// ── session-affinity 头：真的 pi-ai stream，打到线上为止 ────────────────
//
// 配置对象里的 compat 旗子不是证据：它只证明适配器把旗子写进了对象，不证明旗子到得了
// 请求。这里起真的本地 node:http 假上游（复用 startFakeUpstream），用真的 pi-ai stream
// 发一条消息 —— 不打桩 fetch，桩只能断言测试自己构造的东西，断言不了 pi-ai 实际发了什么。
// 上游实现（pi-ai 1.5.2 dist/api/anthropic-messages.js）：sessionId 且
// compat.sendSessionAffinityHeaders 时发 x-session-affinity: <sessionId>
//（sessionAffinityFormat === "openrouter" 才是 x-session-id，本适配器不设）。
// 假上游一律答 400：流以 error 事件收尾，用例不依赖任何模型输出，也不会 hang。

console.log("");
console.log("session-affinity 头（真的 pi-ai stream，本地假上游，不桩 fetch）");

const AFFINITY_SESSION_ID = "sess-probe-123";

/** provider 配置条目 → pi-ai 的 Model：api/baseUrl 取自 toProviderConfig 的产物，其余逐字来自条目 */
function toAiModel(config: PiProviderConfig, entry: PiModelEntry): Model<"anthropic-messages"> {
  return {
    id: entry.id,
    name: entry.name,
    // PiProviderConfig.api 是 string；这条用例固定走 anthropic-messages 方言
    api: config.api as "anthropic-messages",
    provider: config.name,
    baseUrl: config.baseUrl,
    input: entry.input,
    cost: entry.cost,
    reasoning: entry.reasoning,
    thinkingLevelMap: entry.thinkingLevelMap,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: entry.compat,
  };
}

/** 走真的 stream 发一条消息，抓回假上游收到的请求头；400 让流立刻收尾 */
async function captureChatRequestHeaders(entry: PiModelEntry): Promise<Record<string, string>> {
  const fake = await startFakeUpstream(() => ({
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message: "session-affinity probe 到此为止" } },
  }));
  try {
    const config = toProviderConfig(fake.url, "public", [entry]);
    const events = stream(
      toAiModel(config, config.models[0]),
      normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
      { apiKey: "public", sessionId: AFFINITY_SESSION_ID },
    );
    for await (const event of events) {
      if (event.type === "error" || event.type === "done") break;
    }
    // error/done 都在请求发完之后才来：这时假上游必然已经收到请求
    if (fake.requests.length === 0) throw new Error("假上游没有收到任何请求");
    return fake.requests[0].headers;
  } finally {
    await fake.close();
  }
}

{
  const headers = await captureChatRequestHeaders(toPiModelEntry(spec({ id: "sess-affinity", displayName: "Sess Affinity" })));
  check(
    `compat.sendSessionAffinityHeaders=true → 真的请求头带 x-session-affinity: ${AFFINITY_SESSION_ID}（观察值: ${headers["x-session-affinity"] ?? "无"}）`,
    headers["x-session-affinity"] === AFFINITY_SESSION_ID,
    JSON.stringify(headers),
  );
}

{
  // 反向必须真跑（不是 skip）：只测正向的那天，别的头带上 session 字样，正向就为错的理由绿着
  const entry = toPiModelEntry(spec({ id: "sess-off", displayName: "Sess Off" }));
  const offHeaders = await captureChatRequestHeaders({ ...entry, compat: { ...entry.compat, sendSessionAffinityHeaders: false } });
  check(
    "compat.sendSessionAffinityHeaders=false → 请求头里没有任何 session/affinity 字样",
    Object.entries(offHeaders).every(([name, value]) => !/session|affinity/i.test(name) && !/session|affinity/i.test(String(value))),
    JSON.stringify(offHeaders),
  );
}

console.log("");
console.log("forceAdaptiveThinking（真的 streamSimple，假上游断言收到的请求体）");
console.log("  这条旗子只在「走了 streamSimple 且请求了 reasoning」时才生效：thinking 换成 adaptive 形态，");
console.log("  档位写进 output_config.effort。四条用例分别钉住生效、不生效、按档位映射、以及不额外开思考。");

/** 走真实 streamSimple（pi 用的就是它），抓回假上游收到的整条请求：头与体都留着 */
async function captureSimpleChatRequest(
  entry: PiModelEntry,
  reasoning?: "minimal" | "low" | "medium" | "high",
): Promise<CapturedRequest> {
  const fake = await startFakeUpstream(() => ({
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message: "adaptive probe 到此为止" } },
  }));
  try {
    const config = toProviderConfig(fake.url, "public", [entry]);
    const events = streamSimple(
      toAiModel(config, config.models[0]),
      normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
      { apiKey: "public", sessionId: AFFINITY_SESSION_ID, reasoning },
    );
    for await (const event of events) {
      if (event.type === "error" || event.type === "done") break;
    }
    // error/done 都在请求发完之后才来：这时假上游必然已经收到请求
    const first = fake.last();
    if (!first) throw new Error("假上游没有收到任何请求");
    return first;
  } finally {
    await fake.close();
  }
}

type AdaptiveBody = {
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
};

{
  const req = await captureSimpleChatRequest(toPiModelEntry(spec({ id: "adapt-on", displayName: "Adapt On" })), "high");
  const body = req.json<AdaptiveBody>();
  check(
    `forceAdaptiveThinking=true + reasoning=high → thinking.type=adaptive 且 output_config.effort=high（观察值: ${JSON.stringify(body?.thinking)} / ${JSON.stringify(body?.output_config)}）`,
    body?.thinking?.type === "adaptive" && body?.output_config?.effort === "high",
    req.body,
  );
}

{
  // 反向必须真跑：它同时证明「adaptive 不是因为我们什么都发 adaptive 才绿」
  const on = toPiModelEntry(spec({ id: "adapt-off", displayName: "Adapt Off" }));
  const req = await captureSimpleChatRequest(
    { ...on, compat: { ...on.compat, forceAdaptiveThinking: false } },
    "high",
  );
  const body = req.json<AdaptiveBody>();
  check(
    `forceAdaptiveThinking=false + reasoning=high → thinking.type=enabled（预算制）且没有 output_config（观察值: ${JSON.stringify(body?.thinking)}）`,
    body?.thinking?.type === "enabled" && body?.output_config === undefined,
    req.body,
  );
}

{
  // 档位必须来自 reasoning：把 effort 写死成 high 的实现会在这里红
  const req = await captureSimpleChatRequest(toPiModelEntry(spec({ id: "adapt-low", displayName: "Adapt Low" })), "low");
  const body = req.json<AdaptiveBody>();
  check(
    `forceAdaptiveThinking=true + reasoning=low → output_config.effort=low（观察值: ${JSON.stringify(body?.output_config)}）`,
    body?.output_config?.effort === "low",
    req.body,
  );
}

{
  // 旗子不能自己开思考：没请求 reasoning 时必须还是 disabled
  const req = await captureSimpleChatRequest(toPiModelEntry(spec({ id: "adapt-none", displayName: "Adapt None" })));
  const body = req.json<AdaptiveBody>();
  check(
    `forceAdaptiveThinking=true 但不请求 reasoning → 既不是 adaptive 也没有 output_config（观察值: thinking=${JSON.stringify(body?.thinking)}, output_config=${JSON.stringify(body?.output_config)}）`,
    body?.thinking?.type !== "adaptive" && body?.output_config === undefined,
    req.body,
  );
}
console.log("");
// ── 子代理会话头：pi 钩子 + 父会话首行 ─────────────────────────────────
//
// 这里的父会话是临时文件，钩子由真正的工厂注册；只读本地文件，不碰用户会话目录。
console.log("");
console.log("子代理会话头（pi 钩子，父会话首行）");

const PARENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-headers-"));
const UUID_PARENT = path.join(PARENT_DIR, "2026-01-01_11111111-2222-3333-4444-555555555555.jsonl");
const BAD_PARENT = path.join(PARENT_DIR, "2026-01-01_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
const PLAIN_PARENT = path.join(PARENT_DIR, "plain.jsonl");
const CACHE_PARENT = path.join(PARENT_DIR, "cache.jsonl");
fs.writeFileSync(UUID_PARENT, '{"id":"parent-first-line","type":"session"}\n{"id":"parent-second-line"}\n');
fs.writeFileSync(BAD_PARENT, "{ not json\n");
fs.writeFileSync(PLAIN_PARENT, "{ not json\n");
fs.writeFileSync(CACHE_PARENT, '{"id":"cached-first"}\n');

check(
	"只读父会话首行（第二行也有 id 时不能覆盖）",
	readFirstLineSync(UUID_PARENT) === '{"id":"parent-first-line","type":"session"}',
	JSON.stringify(readFirstLineSync(UUID_PARENT)),
);
check(
	"父会话路径 → 首行 JSON 的 id 是权威，不是文件名里的 uuid",
	createParentSessionIdResolver().resolve(UUID_PARENT) === "parent-first-line",
	String(createParentSessionIdResolver().resolve(UUID_PARENT)),
);
check(
	"首行坏 JSON → 文件名 uuid（逐字，大小写原样）",
	createParentSessionIdResolver().resolve(BAD_PARENT) === "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	String(createParentSessionIdResolver().resolve(BAD_PARENT)),
);
check(
	"首行坏 JSON 且文件名没有 uuid → 父 id 未解析（null）",
	createParentSessionIdResolver().resolve(PLAIN_PARENT) === null,
	String(createParentSessionIdResolver().resolve(PLAIN_PARENT)),
);
{
	let reads = 0;
	const cached = createParentSessionIdResolver(() => {
		reads++;
		return '{"id":"cached-first"}';
	});
	const first = cached.resolve(CACHE_PARENT);
	fs.writeFileSync(CACHE_PARENT, '{"id":"cached-changed"}\n');
	const second = cached.resolve(CACHE_PARENT);
	check(
		"按路径缓存命中：第二次不读文件，仍返回第一次的 id",
		first === "cached-first" && second === "cached-first" && reads === 1,
		JSON.stringify({ first, second, reads }),
	);
}

const hookPi = fakePi();
const offlineFetch = (async () => {
	throw new Error("offline");
}) as unknown as typeof fetch;
await facadeModels(hookPi, {
	env: {},
	home: tempHome(),
	warn: () => {},
	fetchOptions: { fetchImpl: offlineFetch },
});
check(
	"工厂挂上 before_agent_start 与 before_provider_headers（与网关是否可达无关）",
	typeof hookPi.hooks.beforeAgentStart === "function" && typeof hookPi.hooks.beforeProviderHeaders === "function",
	JSON.stringify(Object.keys(hookPi.hooks)),
);

interface HeaderCtxOptions {
	sessionId?: string;
	sessionName?: string;
	cwd?: string;
}
function headerCtx(parentSession: string | null, opts: HeaderCtxOptions = {}): HookContextLike {
	return {
		sessionManager: {
			getHeader: () => (parentSession === null ? {} : { parentSession }),
			getSessionId: () => opts.sessionId ?? "child-default",
			getSessionFile: () => path.join(PARENT_DIR, "child.jsonl"),
			getSessionName: () => opts.sessionName ?? "",
			getCwd: () => opts.cwd ?? PARENT_DIR,
		},
	};
}
function sendHeaders(ctx: HookContextLike, initial: Record<string, string>): Record<string, string> {
	const event: ProviderHeaderEvent = { headers: initial };
	hookPi.hooks.beforeProviderHeaders?.(event, ctx);
	return initial;
}

{
	const ctx = headerCtx(UUID_PARENT, { sessionId: " child-session-id ", sessionName: "not-an-agent" });
	const start: AgentStartEvent = { systemPrompt: 'you are helpful\n<active_agent name="coder-one">\n...' };
	hookPi.hooks.beforeAgentStart?.(start, ctx);
	const reserved = { "x-session-id": "pi-parent-cache", "x-session-affinity": "pi-parent-cache" };
	const headers = sendHeaders(ctx, { ...reserved });
	check(
		"子会话三头逐字；pi / pi-subagents 的路由头保持父会话值（覆盖会破坏 prompt cache）",
		same(headers, {
			...reserved,
			"x-pi-session-id": "child-session-id",
			"x-parent-session-id": "parent-first-line",
			"x-agent-name": "coder-one",
		}),
		JSON.stringify(headers),
	);
}
{
	const ctx = headerCtx(null, { sessionId: "root-1", sessionName: "coder-root" });
	hookPi.hooks.beforeAgentStart?.({ systemPrompt: '<active_agent name="ignored">' }, ctx);
	const headers = sendHeaders(ctx, { "x-session-id": "pi-root", "x-session-affinity": "pi-root" });
	check(
		"根会话一个头都不写（有 agent 名也不写）—— 只由 parentSession 决定",
		same(headers, { "x-session-id": "pi-root", "x-session-affinity": "pi-root" }),
		JSON.stringify(headers),
	);
}
{
	const ctx = headerCtx(UUID_PARENT, { sessionId: "child-2", sessionName: "coder.two" });
	const headers = sendHeaders(ctx, {});
	check(
		"没有权威标记 → 会话名像 agent 名时逐字写入（两级回退）",
		same(headers, {
			"x-pi-session-id": "child-2",
			"x-parent-session-id": "parent-first-line",
			"x-agent-name": "coder.two",
		}),
		JSON.stringify(headers),
	);
}
{
	const ctx = headerCtx(UUID_PARENT, { sessionId: "child-3", sessionName: "会话 名称" });
	const headers = sendHeaders(ctx, {});
	check(
		"会话名不像 agent 名 → 省略 x-agent-name，但子/父 id 照写",
		same(headers, {
			"x-pi-session-id": "child-3",
			"x-parent-session-id": "parent-first-line",
		}) && !Object.hasOwn(headers, "x-agent-name"),
		JSON.stringify(headers),
	);
}
{
	const ctx = headerCtx(PLAIN_PARENT, { sessionId: "child-4", sessionName: "coder" });
	const headers = sendHeaders(ctx, {});
	check(
		"父 id 解析失败 → 不写父头，也不把整个子会话头一起丢掉",
		same(headers, { "x-pi-session-id": "child-4", "x-agent-name": "coder" }),
		JSON.stringify(headers),
	);
}
{
	const ctx = headerCtx(path.basename(UUID_PARENT), { cwd: PARENT_DIR, sessionId: "child-5", sessionName: "coder" });
	const headers = sendHeaders(ctx, {});
	check(
		"parentSession 是相对路径时按 getCwd 解析，仍读到首行 id",
		same(headers, {
			"x-pi-session-id": "child-5",
			"x-parent-session-id": "parent-first-line",
			"x-agent-name": "coder",
		}),
		JSON.stringify(headers),
	);
}
{
	const broken: HookContextLike = {
		sessionManager: {
			getHeader() {
				throw new Error("header exploded");
			},
			getSessionId: () => "child-6",
			getSessionName: () => "coder",
		},
	};
	const headers = sendHeaders(broken, { "x-session-id": "keep" });
	check("sessionManager 抛错被吞掉，原有请求头不动、不抛", same(headers, { "x-session-id": "keep" }), JSON.stringify(headers));
}

console.log(fail === 0 ? `全部通过（${pass} 条）` : `${fail} 条失败，${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
