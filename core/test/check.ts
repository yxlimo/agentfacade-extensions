// core/test/check.ts — core 的自检。
//
//   node --experimental-strip-types core/test/check.ts
//
// 全部离线：网络用注入的 fetch 伪造（core 的 fetchModelList 收 fetchImpl），
// 不连真网关、不起端口、不读真实主目录。配置文件在这里只是一个「返回字符串的函数」。
//
// 期望值一律手写并逐字比对（JSON 序列化后全等），不写「是对象」「是数组」这种断言 ——
// 那种断言在映射改坏以后照样绿，什么也没钉住。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  modelsFromPayload,
  normalizeCost,
  normalizeEfforts,
  normalizeModalities,
  normalizeReasoning,
  toModelSpec,
} from "../catalog.ts";
import {
  DEFAULT_TIMEOUT_MS,
  MODELS_DIALECT,
  fetchCatalog,
  fetchModelList,
  modelsUrl,
  resolveGateway,
} from "../gateway.ts";
import { readAuthKeyAt, resolveAuthKey, writeAuthKeyAt } from "../auth.ts";
import { createCatalogPoller, DEFAULT_REFRESH_MS, MIN_REFRESH_MS, resolveRefreshMs, type PollerTimers } from "../poll.ts";
import {
  DEFAULT_GATEWAY,
  normalizeGatewayInput,
  resolveFacadeGateway,
  writeFacadeConfig,
} from "../gateway-config.ts";
import { syncCatalog, type SyncDeps, type SyncState } from "../sync.ts";
import { probeModels, probePlan, type ProbeResult } from "../probe.ts";
import type { HostAdapter, ModelSpec } from "../types.ts";

import {
	SESSION_HEADERS,
	buildSessionHeaders,
	normalizeAgentName,
	normalizeSessionId,
} from "../session-headers.ts";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.join(HERE, "..");

// 网关报文的形状只有 fixtures/gateway-openai.json 一处：用例从它取一条再改单格，
// 不在每个用例里重抄整份 payload —— 重抄的那份迟早和网关的真实形状分叉，而重抄的用例照样绿。
type GatewayPayload = { object: string; data: Array<Record<string, unknown>> };
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "gateway-openai.json"), "utf8"),
) as GatewayPayload;

/** 取 fixture 里的一条模型，深拷贝一份随便改（共享同一个对象会被上一条用例改坏） */
function row(id: string): Record<string, unknown> {
  const found = FIXTURE.data.find((item) => item.id === id);
  if (!found) throw new Error(`fixture 里没有 ${id}`);
  return structuredClone(found);
}

/** 改 fixture 一条模型的某一格，用来造「网关没报这一格 / 报了个怪值」的变体 */
function withField(base: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(base);
  copy[key] = value;
  return copy;
}

/** 整格拿掉：模拟网关没发这一层（缺失与「发了个空对象」在语义上不同） */
function without(base: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = structuredClone(base);
  delete copy[key];
  return copy;
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

/** 注入用的假 fetch：记录被请求的地址/方法/accept（带了密钥还有 authorization），回答由 respond 决定 */
function captureFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string; accept: string; authorization?: string }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // authorization 只在真的带了的时候记录：没带密钥的既有快照（url/method/accept 三格）保持原样
    const authorization = headers.authorization ?? "";
    calls.push({
      url,
      method: init?.method ?? "",
      accept: headers.accept ?? "",
      ...(authorization !== "" ? { authorization } : {}),
    });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 永不响应的上游：只有 abort 才有反应。超时与取消两条路都靠它 */
const hangFetch = (async (_input: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as unknown as typeof fetch;

// ── 字段归一化 ───────────────────────────────────────────────────────────

console.log("toModelSpec（逐字快照，openai 渲染）");

check(
  "完整一条：能力/上限/模态/报价各就各位（fixture 的 model-01）",
  same(toModelSpec(row("model-01")), {
    id: "model-01",
    displayName: "Model 01",
    reasoning: true,
    efforts: ["off", "low", "high", "max"],
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    toolCall: true,
    modalities: {
      input: ["text", "image/jpeg", "image/png", "image/gif", "image/webp"],
      output: ["text"],
    },
    cost: { inputPerMillion: 0.15, cacheReadPerMillion: 0.003, outputPerMillion: 0.6 },
  }),
  JSON.stringify(toModelSpec(row("model-01"))),
);

check(
  "整份 fixture 逐字（含只有 id 的那条：三层全缺时的回落一起钉住）",
  same(modelsFromPayload(FIXTURE.data), [
    {
      id: "model-01",
      displayName: "Model 01",
      reasoning: true,
      efforts: ["off", "low", "high", "max"],
      contextWindow: 1000000,
      maxOutputTokens: 384000,
      toolCall: true,
      modalities: {
        input: ["text", "image/jpeg", "image/png", "image/gif", "image/webp"],
        output: ["text"],
      },
      cost: { inputPerMillion: 0.15, cacheReadPerMillion: 0.003, outputPerMillion: 0.6 },
    },
    {
      id: "model-02",
      displayName: "Model 02",
      reasoning: true,
      efforts: ["off", "default", "low", "medium", "high", "xhigh", "max"],
      contextWindow: 200000,
      maxOutputTokens: 128000,
      toolCall: true,
      modalities: { input: ["text"], output: ["text"] },
      cost: { inputPerMillion: 1.25, cacheReadPerMillion: 0.125, outputPerMillion: 10 },
    },
    {
      id: "model-03",
      displayName: "Model 03",
      reasoning: false,
      efforts: [],
      contextWindow: 128000,
      maxOutputTokens: 16384,
      toolCall: false,
      modalities: { input: ["text"], output: ["text"] },
      cost: { inputPerMillion: 0, cacheReadPerMillion: 0, outputPerMillion: 0 },
    },
    {
      id: "model-04",
      displayName: "model-04",
      reasoning: true,
      efforts: [],
      contextWindow: 200000,
      maxOutputTokens: 4096,
      toolCall: null,
      modalities: null,
      cost: null,
    },
  ]),
  JSON.stringify(modelsFromPayload(FIXTURE.data)),
);

check(
  "缺 capabilities 整层：思考按 true、档位空、toolCall 是 null（不是 false，也不是 true）",
  same(toModelSpec(without(row("model-01"), "capabilities")), {
    id: "model-01",
    displayName: "Model 01",
    reasoning: true,
    efforts: [],
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    toolCall: null,
    modalities: {
      input: ["text", "image/jpeg", "image/png", "image/gif", "image/webp"],
      output: ["text"],
    },
    cost: { inputPerMillion: 0.15, cacheReadPerMillion: 0.003, outputPerMillion: 0.6 },
  }),
  JSON.stringify(toModelSpec(without(row("model-01"), "capabilities"))),
);

check(
  "缺 limit 整层 → 200000 / 4096（不连带影响能力字段）",
  same(
    [
      toModelSpec(without(row("model-01"), "limit")).contextWindow,
      toModelSpec(without(row("model-01"), "limit")).maxOutputTokens,
      toModelSpec(without(row("model-01"), "limit")).toolCall,
    ],
    [200000, 4096, true],
  ),
  JSON.stringify(toModelSpec(without(row("model-01"), "limit"))),
);

check(
  "缺 name / name 是空串 → displayName 回落 id",
  same(
    [toModelSpec(without(row("model-01"), "name")).displayName, toModelSpec(withField(row("model-01"), "name", "")).displayName],
    ["model-01", "model-01"],
  ),
  JSON.stringify([
    toModelSpec(without(row("model-01"), "name")).displayName,
    toModelSpec(withField(row("model-01"), "name", "")).displayName,
  ]),
);

check(
  "导出的缺省值常量就是 200000 / 4096（agent 不该各写一份）",
  DEFAULT_CONTEXT_WINDOW === 200000 && DEFAULT_MAX_OUTPUT_TOKENS === 4096,
  `${DEFAULT_CONTEXT_WINDOW}/${DEFAULT_MAX_OUTPUT_TOKENS}`,
);

check(
  "limit 写 0 也算「没说」（0 是网关表达没填的方式，不是零窗口）",
  same(
    [
      toModelSpec(withField(row("model-01"), "limit", { context: 0, output: 0 })).contextWindow,
      toModelSpec(withField(row("model-01"), "limit", { context: 0, output: 0 })).maxOutputTokens,
    ],
    [200000, 4096],
  ),
  JSON.stringify(toModelSpec(withField(row("model-01"), "limit", { context: 0, output: 0 }))),
);

check(
  "limit 里是数字字符串也认（网关有些字段是字符串）",
  toModelSpec(withField(row("model-01"), "limit", { context: "131072", output: "32768" })).contextWindow === 131072,
  String(toModelSpec(withField(row("model-01"), "limit", { context: "131072", output: "32768" })).contextWindow),
);

check(
  "reasoning.supported 未声明 → true（不知道不等于不支持）",
  toModelSpec(withField(row("model-03"), "capabilities", { tools: { supported: true } })).reasoning === true,
  String(toModelSpec(withField(row("model-03"), "capabilities", { tools: { supported: true } })).reasoning),
);

check(
  "reasoning.supported 不是布尔（字符串）也按「不知道」→ true，不当成 false",
  toModelSpec(withField(row("model-03"), "capabilities", { tools: { supported: true }, reasoning: { supported: "yes" } }))
    .reasoning === true,
  JSON.stringify(
    toModelSpec(withField(row("model-03"), "capabilities", { tools: { supported: true }, reasoning: { supported: "yes" } }))
      .reasoning,
  ),
);

check(
  "reasoning.supported: false 保留 false（fixture 的 model-03）",
  toModelSpec(row("model-03")).reasoning === false,
  String(toModelSpec(row("model-03")).reasoning),
);

check(
  "tools.supported: false 是 false，缺失是 null —— 「不能」与「不知道」不能混成一格",
  same([toModelSpec(row("model-03")).toolCall, toModelSpec(row("model-04")).toolCall], [false, null]),
  JSON.stringify([toModelSpec(row("model-03")).toolCall, toModelSpec(row("model-04")).toolCall]),
);

check(
  "档位原样：不排序、不改拼写（midium 是真实拼写，不许纠正）、不去重",
  same(
    toModelSpec(
      withField(row("model-03"), "capabilities", {
        tools: { supported: true },
        reasoning: { supported: true, effort: ["off", "midium", "high"] },
      }),
    ).efforts,
    ["off", "midium", "high"],
  ),
  JSON.stringify(
    toModelSpec(
      withField(row("model-03"), "capabilities", {
        tools: { supported: true },
        reasoning: { supported: true, effort: ["off", "midium", "high"] },
      }),
    ).efforts,
  ),
);

check(
  "档位缺省 → 空数组（不补 off、不补任何一档；model-03 报了 reasoning 但没有 effort）",
  same(toModelSpec(row("model-03")).efforts, []),
  JSON.stringify(toModelSpec(row("model-03")).efforts),
);

check(
  "档位里混进非字符串就只留字符串项",
  same(normalizeEfforts(["low", 5, null, "", "high"]), ["low", "high"]),
  JSON.stringify(normalizeEfforts(["low", 5, null, "", "high"])),
);

check(
  "档位那格不是数组 → 当成没有这一格",
  normalizeEfforts("low,high") === null && normalizeEfforts({ low: true }) === null && normalizeEfforts(undefined) === null,
  JSON.stringify([normalizeEfforts("low,high"), normalizeEfforts({ low: true }), normalizeEfforts(undefined)]),
);

check(
  "档位全是空串 → 当成没有这一格，不是空数组",
  normalizeEfforts(["", ""]) === null,
  JSON.stringify(normalizeEfforts(["", ""])),
);

check("normalizeReasoning 只认布尔", normalizeReasoning(true) === true && normalizeReasoning(0) === null, JSON.stringify([normalizeReasoning(true), normalizeReasoning(0)]));

check(
  "模态只有 input 一侧 → 整格 null（不拿 [] 顶替 output：那是替网关宣布「不收」）",
  toModelSpec(withField(row("model-01"), "modalities", { input: ["text"] })).modalities === null &&
    normalizeModalities({ input: ["text"] }) === null,
  JSON.stringify([
    toModelSpec(withField(row("model-01"), "modalities", { input: ["text"] })).modalities,
    normalizeModalities({ output: ["text"] }),
  ]),
);

check(
  "模态两侧都是空数组 → 原样保留（空数组是网关的断言，缺省才是「没说」）",
  same(toModelSpec(withField(row("model-01"), "modalities", { input: [], output: [] })).modalities, {
    input: [],
    output: [],
  }),
  JSON.stringify(toModelSpec(withField(row("model-01"), "modalities", { input: [], output: [] })).modalities),
);

check(
  "模态里有非字符串项 → 整格 null（不是滤掉杂项后照样收）",
  toModelSpec(withField(row("model-01"), "modalities", { input: ["text", 5], output: ["text"] })).modalities === null,
  JSON.stringify(toModelSpec(withField(row("model-01"), "modalities", { input: ["text", 5], output: ["text"] })).modalities),
);

check(
  "报价全 0 仍然是报价：cost 是三键全 0 的对象，不是 null（免费 ≠ 没报价）",
  same(toModelSpec(row("model-03")).cost, { inputPerMillion: 0, cacheReadPerMillion: 0, outputPerMillion: 0 }),
  JSON.stringify(toModelSpec(row("model-03")).cost),
);

check(
  "只报输出价 → cost 里没有 inputPerMillion 这个键，也不拿 0 补上",
  same(toModelSpec(withField(row("model-01"), "cost", { text: { output: { price: 2 } } })).cost, {
    outputPerMillion: 2,
  }) &&
    !Object.hasOwn(
      toModelSpec(withField(row("model-01"), "cost", { text: { output: { price: 2 } } })).cost ?? {},
      "inputPerMillion",
    ) &&
    !Object.hasOwn(
      toModelSpec(withField(row("model-01"), "cost", { text: { output: { price: 2 } } })).cost ?? {},
      "cacheReadPerMillion",
    ),
  JSON.stringify(toModelSpec(withField(row("model-01"), "cost", { text: { output: { price: 2 } } })).cost),
);

check(
  "cost 缺失 / 空对象 / 价格不是数字 → null（都是「没报价」）",
  same(
    [
      toModelSpec(row("model-04")).cost,
      toModelSpec(withField(row("model-01"), "cost", { text: {} })).cost,
      toModelSpec(withField(row("model-01"), "cost", { text: { input: { price: "0.15" } } })).cost,
    ],
    [null, null, null],
  ),
  JSON.stringify([
    toModelSpec(row("model-04")).cost,
    toModelSpec(withField(row("model-01"), "cost", { text: {} })).cost,
    toModelSpec(withField(row("model-01"), "cost", { text: { input: { price: "0.15" } } })).cost,
  ]),
);

check(
  "normalizeCost 只收报了的键（每百万 token 的美元价，原样不缩放）",
  same(normalizeCost({ text: { input: { price: 3, cache: { read: 0.3 } } } }), {
    inputPerMillion: 3,
    cacheReadPerMillion: 0.3,
  }),
  JSON.stringify(normalizeCost({ text: { input: { price: 3, cache: { read: 0.3 } } } })),
);

console.log("");
console.log("modelsFromPayload");

check(
  "没有 id 的项跳过",
  same(modelsFromPayload([{ id: "" }, { name: "no id" }, { id: "kept" }]).map((m) => m.id), ["kept"]),
  JSON.stringify(modelsFromPayload([{ id: "" }, { name: "no id" }, { id: "kept" }])),
);

check("空清单 → 空数组（「空」的判定由调用方做，不是这里编一条模型出来）", modelsFromPayload([]).length === 0);

check(
  "非对象项不炸：当成没有 id 丢掉",
  same(modelsFromPayload([null, "text", 42, { id: "ok" }]).map((m) => m.id), ["ok"]),
  JSON.stringify(modelsFromPayload([null, "text", 42, { id: "ok" }])),
);

// ── 地址解析 ─────────────────────────────────────────────────────────────

console.log("");
console.log("resolveGateway（候选由调用方排好序）");

const candidates = [
  { from: "FIRST", value: "http://first.example:6450" },
  { from: "SECOND", value: "http://second.example:6450" },
];

check(
  "第一个非空候选赢",
  same(resolveGateway({ candidates, fallback: "http://fallback.example:6450" }), {
    ok: true,
    gateway: "http://first.example:6450",
    from: "FIRST",
  }),
  JSON.stringify(resolveGateway({ candidates, fallback: "http://fallback.example:6450" })),
);

check(
  "空的候选跳过，并去掉空白与末尾斜杠",
  same(
    resolveGateway({
      candidates: [{ from: "FIRST", value: "  " }, { from: "SECOND", value: " http://second.example:6450/// " }],
      fallback: "http://fallback.example:6450",
    }),
    { ok: true, gateway: "http://second.example:6450", from: "SECOND" },
  ),
  JSON.stringify(
    resolveGateway({
      candidates: [{ from: "FIRST", value: "  " }, { from: "SECOND", value: " http://second.example:6450/// " }],
      fallback: "http://fallback.example:6450",
    }),
  ),
);

check(
  "写错的地址（不是 http(s)）报错，不悄悄退到下一级",
  same(resolveGateway({ candidates: [{ from: "FIRST", value: "ftp://nope" }, ...candidates], fallback: "http://fb.example" }), {
    ok: false,
    error: "FIRST is not an http(s) URL: ftp://nope",
  }),
  JSON.stringify(resolveGateway({ candidates: [{ from: "FIRST", value: "ftp://nope" }, ...candidates], fallback: "http://fb.example" })),
);

check(
  "候选都没配时问配置文件，from 用它的 label",
  same(
    resolveGateway({
      candidates: [{ from: "FIRST", value: "" }],
      config: { label: "config file", read: () => ({ value: "http://from-config.example:6450/" }) },
      fallback: "http://fallback.example:6450",
    }),
    { ok: true, gateway: "http://from-config.example:6450", from: "config file" },
  ),
  JSON.stringify(
    resolveGateway({
      candidates: [{ from: "FIRST", value: "" }],
      config: { label: "config file", read: () => ({ value: "http://from-config.example:6450/" }) },
      fallback: "http://fallback.example:6450",
    }),
  ),
);

check(
  "配置文件里的地址写错也报错，不悄悄用默认值",
  same(
    resolveGateway({
      candidates: [],
      config: { label: "config file", read: () => ({ value: "file:///etc/passwd" }) },
      fallback: "http://fallback.example:6450",
    }),
    { ok: false, error: "config file gateway is not an http(s) URL: file:///etc/passwd" },
  ),
  JSON.stringify(
    resolveGateway({
      candidates: [],
      config: { label: "config file", read: () => ({ value: "file:///etc/passwd" }) },
      fallback: "http://fallback.example:6450",
    }),
  ),
);

check(
  "候选与配置文件都空 → 用调用方的默认值，from 是 default",
  same(resolveGateway({ candidates: [{ from: "FIRST", value: "" }], fallback: "http://fb.example:6450" }), {
    ok: true,
    gateway: "http://fb.example:6450",
    from: "default",
  }),
  JSON.stringify(resolveGateway({ candidates: [{ from: "FIRST", value: "" }], fallback: "http://fb.example:6450" })),
);


check(
  "多级配置按顺序问：第一级赢了就不到第二级",
  same(
    resolveGateway({
      candidates: [],
      config: [
        { label: "config file", read: () => ({ value: "http://first.example:6450" }) },
        { label: "legacy config file", read: () => ({ value: "http://legacy.example:6450" }) },
      ],
      fallback: "http://fallback.example:6450",
    }),
    { ok: true, gateway: "http://first.example:6450", from: "config file" },
  ),
  JSON.stringify(
    resolveGateway({
      candidates: [],
      config: [
        { label: "config file", read: () => ({ value: "http://first.example:6450" }) },
        { label: "legacy config file", read: () => ({ value: "http://legacy.example:6450" }) },
      ],
      fallback: "http://fallback.example:6450",
    }),
  ),
);

check(
  "第一级坏了立刻报错，错误原样透传 —— 不退到下一级（坏文件是显式配置，不是「没配」）",
  same(
    resolveGateway({
      candidates: [],
      config: [
        { label: "config file", read: () => ({ error: "config.json is not valid JSON: boom" }) },
        { label: "legacy config file", read: () => ({ value: "http://legacy.example:6450" }) },
      ],
      fallback: "http://fallback.example:6450",
    }),
    { ok: false, error: "config.json is not valid JSON: boom" },
  ),
  JSON.stringify(
    resolveGateway({
      candidates: [],
      config: [
        { label: "config file", read: () => ({ error: "config.json is not valid JSON: boom" }) },
        { label: "legacy config file", read: () => ({ value: "http://legacy.example:6450" }) },
      ],
      fallback: "http://fallback.example:6450",
    }),
  ),
);

console.log("");
console.log("normalizeGatewayInput（/agentfacade connect 的输入）");

check(
  "没有 scheme 没有端口 → 补 http:// 与 :6450（README 的第一种输入）",
  same(normalizeGatewayInput("192.168.1.9"), { ok: true, url: "http://192.168.1.9:6450" }),
  JSON.stringify(normalizeGatewayInput("192.168.1.9")),
);
check(
  "没有 scheme 有端口 → 只补 http://，端口原样（README 的第二种输入）",
  same(normalizeGatewayInput("192.168.1.9:8000"), { ok: true, url: "http://192.168.1.9:8000" }),
  JSON.stringify(normalizeGatewayInput("192.168.1.9:8000")),
);
check(
  "https 不补端口（443 是它自己的默认；README 的第三种输入）",
  same(normalizeGatewayInput("https://gw.example"), { ok: true, url: "https://gw.example" }),
  JSON.stringify(normalizeGatewayInput("https://gw.example")),
);
check(
  "末尾斜杠去掉；http 没写端口时补 :6450 一起发生",
  same(normalizeGatewayInput("http://gw.example/"), { ok: true, url: "http://gw.example:6450" }),
  JSON.stringify(normalizeGatewayInput("http://gw.example/")),
);
check(
  "前后空白 trim 掉",
  same(normalizeGatewayInput("  192.168.1.9  "), { ok: true, url: "http://192.168.1.9:6450" }),
  JSON.stringify(normalizeGatewayInput("  192.168.1.9  ")),
);
check(
  "带路径的地址：路径保留、末尾斜杠去掉，端口照补",
  normalizeGatewayInput("192.168.1.9/base/").ok &&
    (normalizeGatewayInput("192.168.1.9/base/") as { ok: true; url: string }).url === "http://192.168.1.9:6450/base",
  JSON.stringify(normalizeGatewayInput("192.168.1.9/base/")),
);
check(
  "http://x:80 的显式端口不算「没写」：URL 会把默认端口吞掉，靠原文本判定，补 :6450 就是静默改地址",
  same(normalizeGatewayInput("http://gw.example:80"), { ok: true, url: "http://gw.example:80" }),
  JSON.stringify(normalizeGatewayInput("http://gw.example:80")),
);
const refusedScheme = normalizeGatewayInput("ftp://nope");
check(
  "非 http(s) → 报错，不猜测",
  !refusedScheme.ok && refusedScheme.error.includes("only http(s)"),
  JSON.stringify(refusedScheme),
);
const junk = normalizeGatewayInput("not a url");
check(
  "解析失败（空 host）→ 报错",
  !junk.ok && junk.error.includes("not a URL"),
  JSON.stringify(junk),
);
const emptyInput = normalizeGatewayInput("   ");
check(
  "空串 → 报错",
  !emptyInput.ok && emptyInput.error.includes("empty"),
  JSON.stringify(emptyInput),
);
check(
  "file:// 之类一律拒绝",
  !normalizeGatewayInput("file:///etc/passwd").ok,
  JSON.stringify(normalizeGatewayInput("file:///etc/passwd")),
);

console.log("");
console.log("配置文件 ~/.config/agentfacade/config.json 与共用解析链（home 注入临时目录）");

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "facade-config-home-"));
}

/** 造一份我们自己的配置文件；返回完整路径 */
function seedConfig(home: string, body: string): string {
  const dir = path.join(home, ".config", "agentfacade");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, body);
  return file;
}

const CHAIN_ENV_NAMES = ["TEST_AGENT_GATEWAY", "TEST_SHARED_GATEWAY"];

{
  // 写入 → 读回：整条链闭环。文件形状逐字钉住，别让 {"gateway":...} 悄悄长出别的键
  const home = tempHome();
  const written = writeFacadeConfig(home, "http://192.168.1.9:6450");
  const file = path.join(home, ".config", "agentfacade", "config.json");
  check("写成功并返回文件路径", written.ok && written.file === file, JSON.stringify(written));
  check(
    "文件内容逐字：两格缩进、只有 gateway 一格，加一个换行",
    fs.readFileSync(file, "utf8") === '{\n  "gateway": "http://192.168.1.9:6450"\n}\n',
    JSON.stringify(fs.readFileSync(file, "utf8")),
  );
  check("文件权限是 0600（里面有用户自己的网关地址）", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  check("写入后的地址被解析链读回来，from 是 config file", same(resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home }), { ok: true, gateway: "http://192.168.1.9:6450", from: "config file" }), JSON.stringify(resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home })));
}

{
  // 原子性 observable 的一半：覆盖写不留临时文件，内容被替换
  const home = tempHome();
  writeFacadeConfig(home, "http://first.example:6450");
  const again = writeFacadeConfig(home, "http://second.example:6450");
  const dir = path.join(home, ".config", "agentfacade");
  check("覆盖写成功", again.ok, JSON.stringify(again));
  check("覆盖写后内容是新的", fs.readFileSync(path.join(dir, "config.json"), "utf8").includes("second.example"), fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  check("目录里没有残留的临时文件（rename 用掉了它）", fs.readdirSync(dir).every((name) => name === "config.json"), JSON.stringify(fs.readdirSync(dir)));
}

{
  // 写入守卫：非 http(s) 一律拒绝且不落盘 —— docs/design.md 的 connect 规则
  const home = tempHome();
  const refused = writeFacadeConfig(home, "file:///etc/passwd");
  check("拒绝把非 http(s) 地址写进配置文件", !refused.ok && refused.error.includes("refusing"), JSON.stringify(refused));
  check("拒绝时什么都没写出来", fs.existsSync(path.join(home, ".config", "agentfacade")) === false, String(fs.existsSync(path.join(home, ".config", "agentfacade"))));
}

{
  // 写失败：路径被普通文件挡住。错误带原因返回，不抛 —— 调用方（connect）据此保持内存地址不动
  const home = tempHome();
  fs.writeFileSync(path.join(home, ".config"), "not a directory");
  const blocked = writeFacadeConfig(home, "http://192.168.1.9:6450");
  check("目录建不出来 → 写失败并带原因", !blocked.ok && blocked.error.includes("cannot write"), JSON.stringify(blocked));
}

{
  // 优先级从高到低，每一级互相能区分（值不同、from 也不同）
  const home = tempHome();
  seedConfig(home, '{"gateway":"http://new-config.example:6450"}');
  const legacyDir = path.join(home, ".config", "buddy-helper");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "config.json"), '{"gateway":"http://legacy.example:6450/"}');

  const own = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: { TEST_AGENT_GATEWAY: "http://agent.example:6450", TEST_SHARED_GATEWAY: "http://shared.example:6450" }, home });
  check("agent 自己的环境变量最高", same(own, { ok: true, gateway: "http://agent.example:6450", from: "TEST_AGENT_GATEWAY" }), JSON.stringify(own));

  const shared = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: { TEST_AGENT_GATEWAY: " ", TEST_SHARED_GATEWAY: "http://shared.example:6450" }, home });
  check("自己的变量空白算没配，落到共用变量", same(shared, { ok: true, gateway: "http://shared.example:6450", from: "TEST_SHARED_GATEWAY" }), JSON.stringify(shared));

  const fromConfig = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home });
  check("环境变量都空 → 新配置文件，from 是 config file", same(fromConfig, { ok: true, gateway: "http://new-config.example:6450", from: "config file" }), JSON.stringify(fromConfig));

  const legacyOnly = tempHome();
  fs.mkdirSync(path.join(legacyOnly, ".config", "buddy-helper"), { recursive: true });
  fs.writeFileSync(path.join(legacyOnly, ".config", "buddy-helper", "config.json"), '{"gateway":"http://legacy.example:6450/"}');
  const onlyLegacy = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home: legacyOnly });
  check("只有旧路径 → 读它，from 是 legacy config file，末尾斜杠去掉", same(onlyLegacy, { ok: true, gateway: "http://legacy.example:6450", from: "legacy config file" }), JSON.stringify(onlyLegacy));
}

{
  const nowhere = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home: tempHome() });
  check("哪里都没配 → 默认地址（README 的默认值），from 是 default", same(nowhere, { ok: true, gateway: DEFAULT_GATEWAY, from: "default" }), JSON.stringify(nowhere));
  check("默认地址就是 http://127.0.0.1:6450", DEFAULT_GATEWAY === "http://127.0.0.1:6450", DEFAULT_GATEWAY);
}

{
  // 显式写错的地址必须报错：环境变量、新配置文件、旧配置文件三处各一条
  const badEnv = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: { TEST_AGENT_GATEWAY: "ftp://nope" }, home: tempHome() });
  check("环境变量里的坏地址 → 报错点名变量，不退默认", !badEnv.ok && badEnv.error.includes("TEST_AGENT_GATEWAY") && badEnv.error.includes("http(s)"), JSON.stringify(badEnv));

  const brokenHome = tempHome();
  seedConfig(brokenHome, "{ not json");
  const broken = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home: brokenHome });
  check(
    "新配置文件 JSON 坏 → 报错带文件路径与原因（不是当成没配置退默认）",
    !broken.ok && broken.error.includes("agentfacade/config.json") && broken.error.includes("not valid JSON"),
    JSON.stringify(broken),
  );

  const wrongTypeHome = tempHome();
  seedConfig(wrongTypeHome, '{"gateway":42}');
  const wrongType = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home: wrongTypeHome });
  check(
    "gateway 不是字符串 → 报错带实际类型",
    !wrongType.ok && wrongType.error.includes('"gateway"') && wrongType.error.includes("42"),
    JSON.stringify(wrongType),
  );

  const badAddressHome = tempHome();
  seedConfig(badAddressHome, '{"gateway":"ftp://nope"}');
  const badAddress = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home: badAddressHome });
  check("配置文件里的地址不是 http(s) → 报错，from 不会变成 default", !badAddress.ok && badAddress.error.includes("http(s) URL: ftp://nope"), JSON.stringify(badAddress));
}

{
  // 旧文件的宽容是历史行为：坏了当没配。与新文件的严格分开钉，别让谁「顺手统一」
  const legacyBroken = tempHome();
  fs.mkdirSync(path.join(legacyBroken, ".config", "buddy-helper"), { recursive: true });
  fs.writeFileSync(path.join(legacyBroken, ".config", "buddy-helper", "config.json"), "{ not json");
  const fallback = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home: legacyBroken });
  check("旧配置文件 JSON 坏 → 当没配退默认（历史行为，与新文件不同）", same(fallback, { ok: true, gateway: DEFAULT_GATEWAY, from: "default" }), JSON.stringify(fallback));

  const legacyBadAddress = tempHome();
  fs.mkdirSync(path.join(legacyBadAddress, ".config", "buddy-helper"), { recursive: true });
  fs.writeFileSync(path.join(legacyBadAddress, ".config", "buddy-helper", "config.json"), '{"gateway":"ftp://nope"}');
  const bad = resolveFacadeGateway({ envVarNames: CHAIN_ENV_NAMES, env: {}, home: legacyBadAddress });
  check("旧配置文件里的坏地址仍报错（地址是显式配置，坏文件不是）", !bad.ok && bad.error.includes("http(s) URL: ftp://nope"), JSON.stringify(bad));
}
check(
  "清单地址锁定 openai 方言（不依赖网关那边的默认值）",
  modelsUrl("http://gw.example:6450") === `http://gw.example:6450/v1/models?dialect=${MODELS_DIALECT}` &&
    MODELS_DIALECT === "openai",
  modelsUrl("http://gw.example:6450"),
);

check(
  "地址自带 query 时用 & 接，不出现两个 ?（第二个 ? 之后的参数网关不看，方言会静默失效）",
  modelsUrl("http://gw.example:6450?token=abc") === "http://gw.example:6450/v1/models?token=abc&dialect=openai",
  modelsUrl("http://gw.example:6450?token=abc"),
);

// ── 拉取：成功与各类失败 ──────────────────────────────────────────────────

console.log("");
console.log("fetchModelList / fetchCatalog（注入 fetch，不连网）");

{
  const { impl, calls } = captureFetch(() => jsonResponse({ data: [{ id: "model-01" }, { id: "model-02" }] }));
  const listed = await fetchModelList("http://gw.example:6450", { fetchImpl: impl });
  check(
    "答了 JSON → 交出 data 数组",
    listed.ok && same((listed as { data: unknown[] }).data, [{ id: "model-01" }, { id: "model-02" }]),
    JSON.stringify(listed),
  );
  check(
    "打的是 {gateway}/v1/models?dialect=openai，GET + accept: application/json",
    same(calls, [{ url: "http://gw.example:6450/v1/models?dialect=openai", method: "GET", accept: "application/json" }]),
    JSON.stringify(calls),
  );
  {
    // 地址自带 query 时，方言参数必须接在已有参数后面：拼出两个 "?" 的话网关只看到前一段，
    // 方言静默失效，而请求看起来是成功的（这类失败只在报文解析错位时才暴露）
    const withQuery = captureFetch(() => jsonResponse({ data: [{ id: "model-01" }] }));
    await fetchModelList("http://gw.example:6450?token=abc", { fetchImpl: withQuery.impl });
    check(
      "地址自带 query 时不拼出第二个 ?，方言仍然生效",
      same(withQuery.calls, [
        { url: "http://gw.example:6450/v1/models?token=abc&dialect=openai", method: "GET", accept: "application/json" },
      ]),
      JSON.stringify(withQuery.calls),
    );
  }
}

{
  const { impl } = captureFetch(() => new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" } }));
  const listed = await fetchModelList("http://gw.example:6450", { fetchImpl: impl });
  check(
    "非 JSON 报「did not answer a JSON object」",
    !listed.ok && (listed as { error: string }).error === 'http://gw.example:6450/v1/models?dialect=openai did not answer a JSON object',
    JSON.stringify(listed),
  );
}

{
  const { impl } = captureFetch(() => jsonResponse({ object: "list" }));
  const listed = await fetchModelList("http://gw.example:6450", { fetchImpl: impl });
  check(
    "没有 data 那一格报「no \"data\" list」而不是当成空清单",
    !listed.ok && (listed as { error: string }).error === 'http://gw.example:6450/v1/models?dialect=openai has no "data" list',
    JSON.stringify(listed),
  );
}

{
  const { impl } = captureFetch(() => jsonResponse({ error: "boom" }, 500));
  const listed = await fetchModelList("http://gw.example:6450", { fetchImpl: impl });
  check(
    "HTTP 500 报状态码",
    !listed.ok && (listed as { error: string }).error === "http://gw.example:6450/v1/models?dialect=openai answered HTTP 500",
    JSON.stringify(listed),
  );
}

{
  const impl = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6450");
  }) as unknown as typeof fetch;
  const listed = await fetchModelList("http://gw.example:6450", { fetchImpl: impl });
  check(
    "连不上报「unreachable」并带上原因，不抛",
    !listed.ok &&
      (listed as { error: string }).error ===
        "http://gw.example:6450/v1/models?dialect=openai unreachable: connect ECONNREFUSED 127.0.0.1:6450",
    JSON.stringify(listed),
  );
}

{
  const started = Date.now();
  const listed = await fetchModelList("http://gw.example:6450", { timeoutMs: 150, fetchImpl: hangFetch });
  const elapsed = Date.now() - started;
  check(
    "永不响应的上游按超时报失败",
    !listed.ok && (listed as { error: string }).error === "http://gw.example:6450/v1/models?dialect=openai timed out after 150ms",
    JSON.stringify(listed),
  );
  check(`超时时间被遵守（${elapsed}ms，下限 140ms）`, elapsed >= 140 && elapsed < 800, `${elapsed}ms`);
}

{
  const controller = new AbortController();
  controller.abort();
  const listed = await fetchModelList("http://gw.example:6450", { timeoutMs: 5000, fetchImpl: hangFetch, signal: controller.signal });
  check(
    "已经 abort 的 signal 一次请求都不发（发了就等一个永不回话的上游）",
    !listed.ok && (listed as { cancelled: boolean }).cancelled === true,
    JSON.stringify(listed),
  );
}

{
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const listed = await fetchModelList("http://gw.example:6450", { timeoutMs: 5000, fetchImpl: hangFetch, signal: controller.signal });
  check(
    "在飞的请求被调用方取消 → cancelled，不是超时",
    !listed.ok && (listed as { cancelled: boolean }).cancelled === true && (listed as { error: string }).error.endsWith("cancelled"),
    JSON.stringify(listed),
  );
}

check("core 的默认超时是 5 秒（启动路径上的调用方必须自己传更小的数）", DEFAULT_TIMEOUT_MS === 5000, String(DEFAULT_TIMEOUT_MS));

{
  // 用 fixture 里只有 id 的那条走一遍端到端：网关回的真实形状，三层缺省一起落到 ModelSpec
  const { impl } = captureFetch(() => jsonResponse({ object: "list", data: [row("model-04")] }));
  const catalog = await fetchCatalog("http://gw.example:6450", { fetchImpl: impl });
  check(
    "fetchCatalog 交出归一化后的 ModelSpec（逐字）",
    same(catalog, {
      ok: true,
      specs: [
        {
          id: "model-04",
          displayName: "model-04",
          reasoning: true,
          efforts: [],
          contextWindow: 200000,
          maxOutputTokens: 4096,
          toolCall: null,
          modalities: null,
          cost: null,
        },
      ],
    }),
    JSON.stringify(catalog),
  );
}

{
  const { impl } = captureFetch(() => jsonResponse({ data: [] }));
  const catalog = await fetchCatalog("http://gw.example:6450", { fetchImpl: impl });
  check(
    "空清单是失败（不是 ok + 0 条），文案说 listed no models",
    same(catalog, { ok: false, cancelled: false, error: "http://gw.example:6450/v1/models?dialect=openai listed no models" }),
    JSON.stringify(catalog),
  );
}

{
  // 有 data 但每条都没有 id：归一化后是 0 条，同样不能当成「有清单」
  const { impl } = captureFetch(() => jsonResponse({ data: [{ name: "no id" }] }));
  const catalog = await fetchCatalog("http://gw.example:6450", { fetchImpl: impl });
  check("data 里的项全没有 id 也算空清单", !catalog.ok, JSON.stringify(catalog));
}

// ── 状态机 ───────────────────────────────────────────────────────────────

console.log("");
console.log("syncCatalog（状态机）");

type HostModel = string;

function freshState(): SyncState<HostModel> {
  return { gateway: "", from: "", lastGood: [], lastRefresh: null, lastError: null, registered: false };
}

/** agent 只需要给两样：地址怎么解析、自己的模型形状怎么生成 */
function deps(overrides: Partial<SyncDeps<HostModel>> = {}): SyncDeps<HostModel> {
  return {
    resolve: () => ({ ok: true, gateway: "http://gw.example:6450", from: "test" }),
    toHost: (specs) => specs.map((spec) => spec.id),
    fetchOptions: { timeoutMs: 200 },
    now: () => 1700000000000,
    ...overrides,
  };
}

{
  const state = freshState();
  const { impl } = captureFetch(() => jsonResponse({ data: [{ id: "model-01" }, { id: "model-02" }] }));
  const outcome = await syncCatalog(state, deps({ fetchOptions: { timeoutMs: 200, fetchImpl: impl } }));
  check(
    "首次成功：交回 agent 形状的清单",
    same(outcome, { ok: true, models: ["model-01", "model-02"] }),
    JSON.stringify(outcome),
  );
  check(
    "首次成功：lastGood / lastRefresh / gateway / from 都写回，lastError 清空",
    same(state, {
      gateway: "http://gw.example:6450",
      from: "test",
      lastGood: ["model-01", "model-02"],
      lastRefresh: 1700000000000,
      lastError: null,
      registered: false,
    }),
    JSON.stringify(state),
  );
}

{
  // 有一个好清单以后，网关挂了
  const state: SyncState<HostModel> = {
    gateway: "http://gw.example:6450",
    from: "test",
    lastGood: ["model-01", "model-02"],
    lastRefresh: 1700000000000,
    lastError: null,
    registered: true,
  };
  const before = state.lastGood;
  const failing = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  const outcome = await syncCatalog(state, deps({ fetchOptions: { timeoutMs: 200, fetchImpl: failing } }));
  check(
    "失败时交回上一次成功的清单（不是空数组）",
    same(outcome, {
      ok: false,
      cancelled: false,
      error: "http://gw.example:6450/v1/models?dialect=openai unreachable: connect ECONNREFUSED",
      models: ["model-01", "model-02"],
    }),
    JSON.stringify(outcome),
  );
  check("失败时 lastGood 一个元素都没动（同一个数组）", state.lastGood === before, JSON.stringify(state.lastGood));
  check("失败时 lastRefresh 不动（还显示上一次成功的时间）", state.lastRefresh === 1700000000000, String(state.lastRefresh));
  check("失败时 lastError 写明原因", state.lastError === "http://gw.example:6450/v1/models?dialect=openai unreachable: connect ECONNREFUSED", String(state.lastError));
  check("失败不清 registered：已经注册出去的东西还在，标志要跟它一致", state.registered === true);
}

{
  // 网关回 200 + 空清单：绝不能替换
  const state: SyncState<HostModel> = {
    gateway: "http://gw.example:6450",
    from: "test",
    lastGood: ["model-01"],
    lastRefresh: 1700000000000,
    lastError: null,
    registered: true,
  };
  const before = state.lastGood;
  const { impl } = captureFetch(() => jsonResponse({ data: [] }));
  const outcome = await syncCatalog(state, deps({ fetchOptions: { timeoutMs: 200, fetchImpl: impl } }));
  check(
    "空清单不替换 lastGood，交回的仍是上一份",
    !outcome.ok && same(outcome.models, ["model-01"]) && state.lastGood === before,
    JSON.stringify({ outcome, lastGood: state.lastGood }),
  );
  check(
    "空清单留下的 lastError 说 listed no models",
    state.lastError === "http://gw.example:6450/v1/models?dialect=openai listed no models",
    String(state.lastError),
  );
}

{
  // agent 的映射一条都没产出（字段全不认识）：同样不能替换
  const state: SyncState<HostModel> = {
    gateway: "http://gw.example:6450",
    from: "test",
    lastGood: ["model-01"],
    lastRefresh: 1700000000000,
    lastError: null,
    registered: false,
  };
  const { impl } = captureFetch(() => jsonResponse({ data: [{ id: "model-09" }] }));
  const outcome = await syncCatalog(state, deps({ toHost: () => [], fetchOptions: { timeoutMs: 200, fetchImpl: impl } }));
  check(
    "映射出 0 条也不替换 lastGood",
    !outcome.ok && same(state.lastGood, ["model-01"]),
    JSON.stringify({ outcome, lastGood: state.lastGood }),
  );
  check("映射出 0 条时 lastError 说明是 mapped to zero", (state.lastError ?? "").includes("mapped to zero usable models"), String(state.lastError));
}

{
  // 取消：不算失败，不动 lastError
  const state: SyncState<HostModel> = {
    gateway: "http://gw.example:6450",
    from: "test",
    lastGood: ["model-01"],
    lastRefresh: 1700000000000,
    lastError: null,
    registered: true,
  };
  const controller = new AbortController();
  controller.abort();
  const outcome = await syncCatalog(
    state,
    deps({ fetchOptions: { timeoutMs: 5000, fetchImpl: hangFetch } }),
    controller.signal,
  );
  check(
    "取消报 cancelled 而不是失败，交回上一份",
    same(outcome, { ok: false, cancelled: true, error: "http://gw.example:6450/v1/models?dialect=openai cancelled", models: ["model-01"] }),
    JSON.stringify(outcome),
  );
  check("取消不动 lastError（这是调用方自己的节流，不是网关出错）", state.lastError === null, String(state.lastError));
}

{
  // 地址写错：不能覆盖上一次用过的地址
  const state: SyncState<HostModel> = {
    gateway: "http://old.example:6450",
    from: "config file",
    lastGood: ["model-01"],
    lastRefresh: 1700000000000,
    lastError: null,
    registered: true,
  };
  let fetched = 0;
  const outcome = await syncCatalog(
    state,
    deps({
      resolve: () => ({ ok: false, error: "FIRST is not an http(s) URL: ftp://nope" }),
      fetchOptions: {
        timeoutMs: 200,
        fetchImpl: (async () => {
          fetched++;
          return jsonResponse({ data: [{ id: "unreachable" }] });
        }) as unknown as typeof fetch,
      },
    }),
  );
  check(
    "地址写错时不发请求、不换地址，只记 lastError",
    same(outcome, { ok: false, cancelled: false, error: "FIRST is not an http(s) URL: ftp://nope", models: ["model-01"] }),
    JSON.stringify(outcome),
  );
  check("地址写错时一次请求都没发", fetched === 0, String(fetched));
  check(
    "地址写错时 gateway/from 保持上一次的值",
    state.gateway === "http://old.example:6450" && state.from === "config file",
    JSON.stringify({ gateway: state.gateway, from: state.from }),
  );
}

{
  // 拉失败时也要能显示「试的是哪个地址、从哪来的」：地址在请求之前就写回
  const state = freshState();
  const failing = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  await syncCatalog(
    state,
    deps({
      resolve: () => ({ ok: true, gateway: "http://127.0.0.1:6450", from: "default" }),
      fetchOptions: { timeoutMs: 200, fetchImpl: failing },
    }),
  );
  check(
    "拉失败时 gateway/from 已经写回（用户才能知道试的是哪、默认值还是配置）",
    state.gateway === "http://127.0.0.1:6450" && state.from === "default",
    JSON.stringify({ gateway: state.gateway, from: state.from }),
  );
}

{
  // 成功一次后清掉上一次的错误
  const state: SyncState<HostModel> = {
    gateway: "",
    from: "",
    lastGood: [],
    lastRefresh: null,
    lastError: "old failure",
    registered: false,
  };
  const { impl } = captureFetch(() => jsonResponse({ data: [{ id: "model-01" }] }));
  const outcome = await syncCatalog(state, deps({ fetchOptions: { timeoutMs: 200, fetchImpl: impl } }));
  check("成功时清掉 lastError", outcome.ok && state.lastError === null, JSON.stringify({ outcome, lastError: state.lastError }));
  check("core 自己不碰 registered 标志（注册是 agent 的事）", state.registered === false, String(state.registered));
}


// ── 密钥：auth.json 与解析链 ─────────────────────────────────────────────

console.log("");
console.log("auth.json（形状学 pi 的 auth.json；home 注入临时目录）");

/** 造一份 auth.json（测试直接写文件，writeAuthKeyAt 的用例另行覆盖写入路径） */
function seedAuth(home: string, body: string): string {
  const dir = path.join(home, ".config", "agentfacade");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "auth.json");
  fs.writeFileSync(file, body);
  return file;
}

{
  // 写入 → 读回闭环；文件形状与权限逐字钉住（pi 的 auth.json 就长这样，别悄悄长出别的键）
  const home = tempHome();
  const written = writeAuthKeyAt(home, "secret-1");
  const file = path.join(home, ".config", "agentfacade", "auth.json");
  check("写成功并返回文件路径", written.ok && written.file === file, JSON.stringify(written));
  check(
    "文件内容逐字：pi 的 auth.json 形状、两格缩进、加一个换行",
    fs.readFileSync(file, "utf8") === '{\n  "agentfacade": {\n    "type": "api_key",\n    "key": "secret-1"\n  }\n}\n',
    JSON.stringify(fs.readFileSync(file, "utf8")),
  );
  check("文件权限是 0600（里面是明文密钥）", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  check("写入的密钥被读回来", same(readAuthKeyAt(home), { value: "secret-1" }), JSON.stringify(readAuthKeyAt(home)));
}

{
  // 原子性 observable 的一半：覆盖写不留临时文件，内容被替换
  const home = tempHome();
  writeAuthKeyAt(home, "first");
  const again = writeAuthKeyAt(home, "second");
  const dir = path.join(home, ".config", "agentfacade");
  check("覆盖写成功且内容是新的", again.ok && fs.readFileSync(path.join(dir, "auth.json"), "utf8").includes("second"), JSON.stringify(again));
  check("目录里没有残留的临时文件（rename 用掉了它）", same(fs.readdirSync(dir), ["auth.json"]), JSON.stringify(fs.readdirSync(dir)));
}

{
  // 写入守卫：空密钥拒绝、写失败带原因返回（调用方据此向用户报错，token 永远不出现在错误里）
  const home = tempHome();
  const refused = writeAuthKeyAt(home, "   ");
  check("空密钥拒绝且什么都不写", !refused.ok && refused.error.includes("empty") && fs.existsSync(path.join(home, ".config")) === false, JSON.stringify(refused));
  fs.writeFileSync(path.join(home, ".config"), "not a directory");
  const blocked = writeAuthKeyAt(home, "k");
  check("目录建不出来 → 写失败并带原因", !blocked.ok && blocked.error.includes("cannot write"), JSON.stringify(blocked));
}

{
  // 读取的宽容（没有 = 没配）与严格（坏了 = 报错）分开钉
  check("文件不存在 → 没有密钥（不是错误）", same(readAuthKeyAt(tempHome()), { value: "" }), JSON.stringify(readAuthKeyAt(tempHome())));
  const noEntry = tempHome();
  seedAuth(noEntry, '{"other": {"type": "api_key", "key": "x"}}');
  check("文件存在但没有我们那一项 → 没有密钥", same(readAuthKeyAt(noEntry), { value: "" }), JSON.stringify(readAuthKeyAt(noEntry)));
  const broken = tempHome();
  seedAuth(broken, "{ not json");
  const bad = readAuthKeyAt(broken);
  check("JSON 坏 → 带原因的失败（不是当没配）", !("value" in bad) && bad.error.includes("not valid JSON") && bad.error.includes("auth.json"), JSON.stringify(bad));
  const wrongType = tempHome();
  seedAuth(wrongType, '{"agentfacade": {"type": "oauth", "key": "x"}}');
  const typeError = readAuthKeyAt(wrongType);
  check("type 不是 api_key → 报错点名实际类型", !("value" in typeError) && typeError.error.includes('"oauth"'), JSON.stringify(typeError));
  const noKey = tempHome();
  seedAuth(noKey, '{"agentfacade": {"type": "api_key"}}');
  check("没有非空 key 字段 → 报错", !("value" in readAuthKeyAt(noKey)), JSON.stringify(readAuthKeyAt(noKey)));
}

console.log("");
console.log("resolveAuthKey（<AGENT> 环境变量 → 共用变量 → auth.json → 默认没有）");

{
  const KEY_ENVS = ["TEST_AGENT_KEY", "TEST_SHARED_KEY"];
  const home = tempHome();
  seedAuth(home, '{"agentfacade": {"type": "api_key", "key": "from-file"}}');
  const own = resolveAuthKey({ envVarNames: KEY_ENVS, env: { TEST_AGENT_KEY: "from-agent", TEST_SHARED_KEY: "from-shared" }, home });
  check("agent 自己的环境变量最高", same(own, { ok: true, key: "from-agent", from: "TEST_AGENT_KEY" }), JSON.stringify(own));
  const shared = resolveAuthKey({ envVarNames: KEY_ENVS, env: { TEST_SHARED_KEY: "from-shared" }, home });
  check("共用变量赢过文件", same(shared, { ok: true, key: "from-shared", from: "TEST_SHARED_KEY" }), JSON.stringify(shared));
  const fromFile = resolveAuthKey({ envVarNames: KEY_ENVS, env: {}, home });
  check("环境变量都空 → auth.json", same(fromFile, { ok: true, key: "from-file", from: "~/.config/agentfacade/auth.json" }), JSON.stringify(fromFile));
  const nowhere = resolveAuthKey({ envVarNames: KEY_ENVS, env: {}, home: tempHome() });
  check("哪里都没有 → 没有密钥（不是错误，key 是空串）", same(nowhere, { ok: true, key: "", from: "none" }), JSON.stringify(nowhere));
  const brokenHome = tempHome();
  seedAuth(brokenHome, "{ not json");
  const broken = resolveAuthKey({ envVarNames: KEY_ENVS, env: {}, home: brokenHome });
  check("auth.json 坏 → 报错带原因，不悄悄当没配", !broken.ok && broken.error.includes("not valid JSON"), JSON.stringify(broken));
  const blank = resolveAuthKey({ envVarNames: KEY_ENVS, env: { TEST_AGENT_KEY: "  " }, home: tempHome() });
  check("空白的环境变量算没配，落到下一级", blank.ok && blank.from === "none", JSON.stringify(blank));
}

console.log("");
console.log("catalog 请求的 Authorization（有密钥带 Bearer，没有就不带）");

{
  const { impl, calls } = captureFetch(() => jsonResponse({ data: [{ id: "m" }] }));
  await fetchModelList("http://gw.example:6450", { fetchImpl: impl, apiKey: "k1" });
  check("有密钥 → Authorization: Bearer <key>", calls[0]?.authorization === "Bearer k1", JSON.stringify(calls[0]));
  const bare = captureFetch(() => jsonResponse({ data: [{ id: "m" }] }));
  await fetchModelList("http://gw.example:6450", { fetchImpl: bare.impl });
  check("没有密钥 → 不带 authorization（维持原行为）", bare.calls[0] !== undefined && !("authorization" in bare.calls[0]), JSON.stringify(bare.calls[0]));
  const emptyKey = captureFetch(() => jsonResponse({ data: [{ id: "m" }] }));
  await fetchModelList("http://gw.example:6450", { fetchImpl: emptyKey.impl, apiKey: "" });
  check("空串密钥按没有处理", emptyKey.calls[0] !== undefined && !("authorization" in emptyKey.calls[0]), JSON.stringify(emptyKey.calls[0]));
}

console.log("");
console.log("resolveRefreshMs（env → config.json refreshMs → 默认 300000，下限 30000）");

{
  const REFRESH_ENVS = ["TEST_REFRESH_ENV"];
  const plain = resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: {}, home: tempHome() });
  check("默认 300000（5 分钟）", plain === DEFAULT_REFRESH_MS && DEFAULT_REFRESH_MS === 300000, String(plain));
  check("环境变量覆盖默认值", resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: { TEST_REFRESH_ENV: "120000" }, home: tempHome() }) === 120000, "");
  const cfgHome = tempHome();
  seedConfig(cfgHome, '{"gateway": "http://gw.example:6450", "refreshMs": 60000}');
  check("config.json 的 refreshMs 生效", resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: {}, home: cfgHome }) === 60000, "");
  check("环境变量赢过 config.json", resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: { TEST_REFRESH_ENV: "45000" }, home: cfgHome }) === 45000, "");
  check("配得更小按 30000 算（env）", resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: { TEST_REFRESH_ENV: "1000" }, home: tempHome() }) === MIN_REFRESH_MS, "");
  const smallHome = tempHome();
  seedConfig(smallHome, '{"refreshMs": 1}');
  check("配得更小按 30000 算（config）", resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: {}, home: smallHome }) === MIN_REFRESH_MS, "");
  const junkHome = tempHome();
  seedConfig(junkHome, '{"refreshMs": "soon"}');
  check("refreshMs 不是数字 → 当没配，退默认", resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: {}, home: junkHome }) === DEFAULT_REFRESH_MS, "");
  const brokenHome = tempHome();
  seedConfig(brokenHome, "{ not json");
  check("config.json JSON 坏 → 间隔照常给默认（间隔不是地址，坏数字不该挡住模型同步）", resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: {}, home: brokenHome }) === DEFAULT_REFRESH_MS, "");
  check("环境变量不是数字 → 落到 config.json", resolveRefreshMs({ envVarNames: REFRESH_ENVS, env: { TEST_REFRESH_ENV: "soon" }, home: cfgHome }) === 60000, "");
}

console.log("");
console.log("createCatalogPoller（注入定时器；unref / 不重复挂载 / 变了才记一行）");

/** 手动时钟：set 记录 (ms, unref 与否) 并把 handler 排进 pending；clear 清空 pending */
function manualTimers() {
  const calls: Array<{ ms: number; unrefed: boolean }> = [];
  const pending: Array<{ fn: () => void }> = [];
  let cleared = 0;
  const timers: PollerTimers = {
    set(fn, ms) {
      const index = calls.length;
      calls.push({ ms, unrefed: false });
      pending.push({ fn });
      return {
        unref() {
          if (calls[index]) calls[index].unrefed = true;
        },
      };
    },
    clear() {
      cleared++;
      pending.length = 0;
    },
  };
  return {
    timers,
    calls,
    cleared: () => cleared,
    pendingCount: () => pending.length,
    runNext() {
      const next = pending.shift();
      if (next) next.fn();
    },
  };
}

/** 让异步的 tick 走完（poll → 比较 → 排下一轮全是微任务） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

{
  const clock = manualTimers();
  const logs: string[] = [];
  let list: readonly string[] = ["a", "b"];
  const poller = createCatalogPoller({
    intervalMs: 5000,
    initialIds: ["a", "b"],
    poll: async () => list,
    log: (message) => logs.push(message),
    timers: clock.timers,
  });
  poller.start();
  check("start 挂一个定时器，间隔就是配置的 intervalMs", clock.calls.length === 1 && clock.calls[0]?.ms === 5000, JSON.stringify(clock.calls));
  check("定时器被 unref（轮询不能阻止进程退出）", clock.calls[0]?.unrefed === true, JSON.stringify(clock.calls));
  poller.start();
  check("重复 start 不挂第二个定时器", clock.calls.length === 1, String(clock.calls.length));
  check("running 为 true", poller.running === true);

  clock.runNext();
  await flush();
  check("清单没变 → 不记日志，排下一轮", logs.length === 0 && clock.pendingCount() === 1, JSON.stringify({ logs, pending: clock.pendingCount() }));

  list = ["b", "c", "d"];
  clock.runNext();
  await flush();
  check("清单变了 → 恰好一行，写明增删", logs.length === 1 && logs[0] === "model catalog changed: added c, d; removed a", JSON.stringify(logs));

  clock.runNext();
  await flush();
  check("基准更新后，同样的清单不再记", logs.length === 1, JSON.stringify(logs));

  poller.stop();
  check("stop 清掉挂着的定时器", clock.cleared() === 1 && clock.pendingCount() === 0 && poller.running === false, JSON.stringify({ cleared: clock.cleared(), pending: clock.pendingCount() }));
  const after = logs.length;
  clock.runNext();
  await flush();
  check("stop 之后 poll 不再被调、不再排轮", logs.length === after && clock.calls.length === 4, JSON.stringify({ logs, calls: clock.calls.length }));
}

{
  const clock = manualTimers();
  const logs: string[] = [];
  let fail = false;
  let list: readonly string[] = ["a"];
  const poller = createCatalogPoller({
    intervalMs: 1,
    initialIds: ["a"],
    poll: async () => (fail ? null : list),
    log: (message) => logs.push(message),
    timers: clock.timers,
  });
  poller.start();
  fail = true;
  clock.runNext();
  await flush();
  check("poll 失败（null）→ 不记变化日志", logs.length === 0, JSON.stringify(logs));
  check("失败后照排下一轮（保留基准，下一轮再试）", clock.pendingCount() === 1, String(clock.pendingCount()));
  fail = false;
  list = ["a", "b"];
  clock.runNext();
  await flush();
  check(
    "失败恢复后基准还是失败前那份 → 新增 b 记一行",
    logs.length === 1 && logs[0] === "model catalog changed: added b; removed none",
    JSON.stringify(logs),
  );

  // 抛异常的 poll 用独立的时钟：clear 是全清的，两个 poller 共享会互相清掉对方的轮次
  const throwClock = manualTimers();
  const throwing = createCatalogPoller({
    intervalMs: 1,
    initialIds: ["x"],
    poll: async () => {
      throw new Error("boom");
    },
    log: (message) => logs.push(message),
    timers: throwClock.timers,
  });
  throwing.start();
  throwClock.runNext();
  await flush();
  check("poll 抛异常不外溢、按失败算（不记日志、照排下一轮）", logs.length === 1 && throwClock.pendingCount() === 1, JSON.stringify({ logs, pending: throwClock.pendingCount() }));
  throwing.stop();
  poller.stop();

}
{
  // 默认定时器走真 setTimeout + unref：跑得动、stop 得掉、不挂住进程
  let polls = 0;
  const poller = createCatalogPoller({
    intervalMs: 20,
    initialIds: ["a"],
    poll: async () => {
      polls++;
      return ["a"];
    },
    log: () => {},
  });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 90));
  check("默认定时器（真 setTimeout + unref）真的在跑", polls >= 2, String(polls));
  poller.stop();
  const stopped = polls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  check("stop 之后默认定时器不再触发", polls === stopped, `${polls} vs ${stopped}`);
}
// ── 跨 agent 契约 ───────────────────────────────────────────────────────────

console.log("");
console.log("HostAdapter 契约");

{
  // 一个最小的适配器：只用来钉住契约的形状 —— 任何 agent 实现长出额外的必需成员，
  // 或者 toProvider 拿到的东西不是 (specs, opts)，这里就编译不过 / 断言不过
  const adapter: HostAdapter<{ name: string; models: string[] }, { registered: boolean }> = {
    id: "fake",
    gatewayEnvVars: ["FAKE_GATEWAY"],
    toProvider(specs, opts) {
      return { name: `${opts.baseUrl}#${opts.apiKey}`, models: specs.map((spec) => spec.id) };
    },
    register(provider) {
      return { registered: provider.models.length > 0 };
    },
  };
  const spec: ModelSpec = {
    id: "model-01",
    displayName: "Model 01",
    reasoning: true,
    efforts: ["low", "high"],
    contextWindow: 1000,
    maxOutputTokens: 100,
    toolCall: null,
    modalities: null,
    cost: null,
  };
  const provider = adapter.toProvider([spec], { baseUrl: "http://gw.example:6450", apiKey: "public" });
  check(
    "toProvider 拿到 (specs, opts) 并原样得到 id 列表",
    same(provider, { name: "http://gw.example:6450#public", models: ["model-01"] }),
    JSON.stringify(provider),
  );
  const registered = await adapter.register(provider, { host: null, notifier: { warn: () => {} } });
  check("register 拿到 provider 与 RegisterContext", same(registered, { registered: true }), JSON.stringify(registered));
}

// ── 探活：分类、并发、容错 ───────────────────────────────────────────────────
console.log("");
console.log("探活（注入 fetch：分类、并发、容错）");

const PROBE_GATEWAY = "http://gw.example:6450";

function probeResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 按请求体里的 model 回答：探活是一模型一请求，假 fetch 必须看得见是哪一条 */
function probeFetch(respond: (model: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body ?? "{}"));
    calls.push({
      url: String(input),
      method: init?.method ?? "",
      headers: init?.headers as Record<string, string>,
      body,
    });
    const model = (body as Record<string, unknown>).model;
    return respond(typeof model === "string" ? model : "");
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 延迟是实测值，逐字快照时只去掉这一格；其余字段一格不漏 */
function withoutLatency(results: readonly ProbeResult[]): unknown[] {
  return results.map(({ latencyMs, ...rest }) => rest);
}

{
  const feed = probeFetch(() => probeResponse({ id: "chatcmpl-1" }));
  const results = await probeModels({
    gateway: PROBE_GATEWAY,
    models: ["m1"],
    apiKey: "sk-probe-secret",
    fetchImpl: feed.impl,
  });
  check(
    "探活请求逐字：chat 路径 / POST / 最小体 / Bearer 头",
    same(feed.calls, [
      {
        url: "http://gw.example:6450/v1/chat/completions?dialect=openai",
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: "Bearer sk-probe-secret" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
      },
    ]),
    JSON.stringify(feed.calls),
  );
  check(
    "200 → ok：HTTP 码保留、成功无 detail",
    same(withoutLatency(results), [{ model: "m1", status: "ok", httpStatus: 200 }]),
    JSON.stringify(withoutLatency(results)),
  );
}

{
  // 延迟若是写死的 0 或常量，范围断言照样绿：用可控时钟把它钉成逐字快照
  const realNow = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  let results: ProbeResult[] = [];
  try {
    const feed = probeFetch(() => {
      clock += 7;
      return probeResponse({});
    });
    results = await probeModels({ gateway: PROBE_GATEWAY, models: ["m1"], fetchImpl: feed.impl });
  } finally {
    Date.now = realNow;
  }
  check(
    "延迟是两次 Date.now 的实测差：逐字 7ms",
    same(results, [{ model: "m1", status: "ok", httpStatus: 200, latencyMs: 7 }]),
    JSON.stringify(results),
  );

  const open = probeFetch(() => probeResponse({}));
  await probeModels({ gateway: PROBE_GATEWAY, models: ["m1"], fetchImpl: open.impl });
  check(
    "没有密钥 → 不带 authorization（public 模式）",
    same(open.calls[0].headers, { accept: "application/json", "content-type": "application/json" }),
    JSON.stringify(open.calls[0].headers),
  );
}

{
  const feed = probeFetch(() => probeResponse({}));
  await probeModels({ gateway: "http://gw.example:6450?token=abc", models: ["m1"], fetchImpl: feed.impl });
  check(
    "探活地址复用统一拼接：自带 query 时用 & 接，不出现第二个 ?",
    feed.calls[0].url === "http://gw.example:6450/v1/chat/completions?token=abc&dialect=openai",
    feed.calls[0].url,
  );
}

{
  const cases: Array<{ name: string; status: number; body: unknown; expected: Record<string, unknown> }> = [
    { name: "401 → auth", status: 401, body: { error: { message: "invalid api key" } }, expected: { status: "auth", httpStatus: 401, detail: "invalid api key" } },
    { name: "403 → auth", status: 403, body: { error: { message: "forbidden model" } }, expected: { status: "auth", httpStatus: 403, detail: "forbidden model" } },
    { name: "402 + exceed quota limit → quota", status: 402, body: { error: { message: "exceed quota limit for coder-a" } }, expected: { status: "quota", httpStatus: 402, detail: "exceed quota limit for coder-a" } },
    { name: "402 + insufficient_quota → quota", status: 402, body: { error: { message: "insufficient_quota" } }, expected: { status: "quota", httpStatus: 402, detail: "insufficient_quota" } },
    { name: "402 没有额度关键词 → quota（402 一律 Payment Required，不看正文）", status: 402, body: { error: { message: "upstream account is out of credits" } }, expected: { status: "quota", httpStatus: 402, detail: "upstream account is out of credits" } },
    { name: "404 → missing（模型 id 不对，动作是改 id）", status: 404, body: { error: { message: "unknown model" } }, expected: { status: "missing", httpStatus: 404, detail: "unknown model" } },
    { name: "429 → throttled（限流，动作是等一会再来）", status: 429, body: { error: { message: "rate limit exceeded" } }, expected: { status: "throttled", httpStatus: 429, detail: "rate limit exceeded" } },
    { name: "400 命中额度词 → quota（词表只作其它状态的辅助）", status: 400, body: { error: { message: "insufficient_quota" } }, expected: { status: "quota", httpStatus: 400, detail: "insufficient_quota" } },
    { name: "其它 2xx（201）→ unclassified，仍然给 detail（只有 200 算 ok）", status: 201, body: "", expected: { status: "unclassified", httpStatus: 201, detail: "HTTP 201" } },
    { name: "502 包着上游 400 → upstream，detail 留上游原文", status: 502, body: { error: { message: "Bad Gateway", upstream: { status: 400, body: "model coder-a is not allowed in this plan" } } }, expected: { status: "upstream", httpStatus: 502, detail: "Bad Gateway | model coder-a is not allowed in this plan" } },
    { name: "502 包着 insufficient_quota → quota（额度词优先于上游标记，detail 仍留上游原文）", status: 502, body: { error: { message: "Bad Gateway", upstream: { body: "insufficient_quota from provider" } } }, expected: { status: "quota", httpStatus: 502, detail: "Bad Gateway | insufficient_quota from provider" } },
    { name: "502 同时有上游 400 与额度词 → quota（额度词优先于上游标记），detail 仍留上游原文", status: 502, body: { error: { message: "Bad Gateway", upstream: { status: 400, body: "provider rejected: quota exceeded" } } }, expected: { status: "quota", httpStatus: 502, detail: "Bad Gateway | provider rejected: quota exceeded" } },
    { name: "502 没有上游线索 → unclassified（不把 502 一律当上游）", status: 502, body: { error: { message: "Bad Gateway" } }, expected: { status: "unclassified", httpStatus: 502, detail: "Bad Gateway" } },
    { name: "502 只有自己的 code:403 → unclassified（code 不算上游证据）", status: 502, body: { error: { message: "Bad Gateway", code: 403 } }, expected: { status: "unclassified", httpStatus: 502, detail: "Bad Gateway" } },
    { name: "502 + 字符串型 upstream 原文 → upstream，detail 留住原文", status: 502, body: { error: { message: "Bad Gateway", upstream: "upstream code 403: plan rejected" } }, expected: { status: "upstream", httpStatus: 502, detail: "Bad Gateway | upstream code 403: plan rejected" } },
    { name: "其它 500 → unclassified，detail 取 error.message", status: 500, body: { error: { message: "internal boom" } }, expected: { status: "unclassified", httpStatus: 500, detail: "internal boom" } },
  ];
  for (const item of cases) {
    const feed = probeFetch(() => probeResponse(item.body, item.status));
    const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["m1"], fetchImpl: feed.impl });
    check(item.name, same(withoutLatency(results), [{ model: "m1", ...item.expected }]), JSON.stringify(withoutLatency(results)));
  }
}

{
  const feed = probeFetch((model) => {
    if (model === "html") return probeResponse("<html>nope</html>", 503);
    if (model === "empty") return probeResponse("", 500);
    return probeResponse({ error: { message: "x".repeat(2000) } }, 500);
  });
  const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["html", "empty", "huge"], fetchImpl: feed.impl });
  check(
    "非 JSON / 空体 / 超长体都不抛，逐字结果与截断长度",
    same(withoutLatency(results), [
      { model: "html", status: "unclassified", httpStatus: 503, detail: "<html>nope</html>" },
      { model: "empty", status: "unclassified", httpStatus: 500, detail: "HTTP 500" },
      { model: "huge", status: "unclassified", httpStatus: 500, detail: `${"x".repeat(399)}…` },
    ]),
    JSON.stringify(withoutLatency(results)),
  );
}

{
  const prefix = '{"error":{"message":"';
  const feed = probeFetch(() => probeResponse(`${prefix}${"y".repeat(6000)} quota exceeded"}` , 400));
  const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["far"], fetchImpl: feed.impl });
  check(
    "几 MB 级错误体先截断再解析：上限外的额度词不参与分类，detail 逐字",
    same(withoutLatency(results), [
      { model: "far", status: "unclassified", httpStatus: 400, detail: `${prefix}${"y".repeat(399 - prefix.length)}…` },
    ]),
    JSON.stringify(withoutLatency(results)),
  );
}

{
  const feed = probeFetch(async (model) => {
    if (model === "slow") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (model === "dead") {
      throw Object.assign(new Error("fetch failed"), {
        cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:6450" },
      });
    }
    if (model === "quota") return probeResponse({ error: { message: "insufficient_quota" } }, 402);
    return probeResponse({});
  });
  const results = await probeModels({
    gateway: PROBE_GATEWAY,
    models: ["ok", "slow", "ok", "dead", "quota"],
    fetchImpl: feed.impl,
  });
  check("模型去重、输出顺序与输入一致", same(results.map((r) => r.model), ["ok", "slow", "dead", "quota"]), JSON.stringify(results.map((r) => r.model)));
  check(
    "一条超时/连接失败不影响其它条，逐字结果",
    same(withoutLatency(results), [
      { model: "ok", status: "ok", httpStatus: 200 },
      { model: "slow", status: "timeout", detail: "aborted" },
      { model: "dead", status: "unreachable", detail: "fetch failed: connect ECONNREFUSED 127.0.0.1:6450" },
      { model: "quota", status: "quota", httpStatus: 402, detail: "insufficient_quota" },
    ]),
    JSON.stringify(withoutLatency(results)),
  );
  check("去重后只发 4 个请求", feed.calls.length === 4, String(feed.calls.length));
}

{
  const hang = (async (_input: unknown, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body ?? "{}"));
    if ((body as Record<string, unknown>).model !== "hang") return probeResponse({});
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }) as unknown as typeof fetch;
  const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["hang", "fine"], timeoutMs: 15, fetchImpl: hang });
  check(
    "自己的超时计时器生效：挂住的模型 timeout，另一条照常 ok",
    same(withoutLatency(results), [
      { model: "hang", status: "timeout", detail: "timed out after 15ms" },
      { model: "fine", status: "ok", httpStatus: 200 },
    ]),
    JSON.stringify(withoutLatency(results)),
  );
}

{
  let inFlight = 0;
  let peak = 0;
  const impl = (async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return probeResponse({});
  }) as unknown as typeof fetch;
  const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["a", "b", "c", "d", "e"], concurrency: 2, fetchImpl: impl });
  check("并发上限：5 条模型、concurrency=2 时在途峰值恰好 2", peak === 2, String(peak));
  check("并发下输出顺序仍与输入一致", same(results.map((r) => r.model), ["a", "b", "c", "d", "e"]), JSON.stringify(results.map((r) => r.model)));
}

{
  const plans: Array<{ name: string; options: { concurrency?: number; timeoutMs?: number }; expected: unknown }> = [
    { name: "concurrency=0", options: { concurrency: 0 }, expected: { count: 3, timeoutMs: 15000, concurrency: 4, worstMs: 15000 } },
    { name: "concurrency=-1", options: { concurrency: -1 }, expected: { count: 3, timeoutMs: 15000, concurrency: 4, worstMs: 15000 } },
    { name: "concurrency=NaN", options: { concurrency: NaN }, expected: { count: 3, timeoutMs: 15000, concurrency: 4, worstMs: 15000 } },
    { name: "concurrency=1e9", options: { concurrency: 1e9 }, expected: { count: 3, timeoutMs: 15000, concurrency: 1e9, worstMs: 15000 } },
    { name: "timeoutMs=0", options: { timeoutMs: 0 }, expected: { count: 3, timeoutMs: 15000, concurrency: 4, worstMs: 15000 } },
    { name: "timeoutMs=-1", options: { timeoutMs: -1 }, expected: { count: 3, timeoutMs: 15000, concurrency: 4, worstMs: 15000 } },
    { name: "timeoutMs=NaN", options: { timeoutMs: NaN }, expected: { count: 3, timeoutMs: 15000, concurrency: 4, worstMs: 15000 } },
    { name: "timeoutMs=1e9", options: { timeoutMs: 1e9 }, expected: { count: 3, timeoutMs: 1e9, concurrency: 4, worstMs: 1e9 } },
  ];
  for (const item of plans) {
    check(`探活参数兜底逐字：${item.name}`, same(probePlan(3, item.options), item.expected), JSON.stringify(probePlan(3, item.options)));
  }
}

{
  let inFlight = 0;
  let peak = 0;
  const impl = (async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return probeResponse({});
  }) as unknown as typeof fetch;
  const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["a", "b", "c"], concurrency: 0, fetchImpl: impl });
  check(
    "concurrency=0 钳到默认 4：三条全探完、在途峰值 3（不是 0 也不是 1）",
    same(results.map((r) => r.model), ["a", "b", "c"]) && peak === 3,
    JSON.stringify({ models: results.map((r) => r.model), peak }),
  );
}

{
  for (const value of [0, -1, NaN]) {
    const impl = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return probeResponse({});
    }) as unknown as typeof fetch;
    const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["m"], timeoutMs: value, fetchImpl: impl });
    check(
      `timeoutMs=${String(value)} 钳回默认 15000：20ms 的慢响应仍是 ok`,
      same(withoutLatency(results), [{ model: "m", status: "ok", httpStatus: 200 }]),
      JSON.stringify(withoutLatency(results)),
    );
  }
}

{
  const feed = probeFetch(() => probeResponse({}));
  const controller = new AbortController();
  controller.abort();
  const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["a", "b"], signal: controller.signal, fetchImpl: feed.impl });
  check(
    "预取消：一条请求都不发，逐字结果都是 cancelled",
    same(withoutLatency(results), [
      { model: "a", status: "cancelled", detail: "cancelled by caller" },
      { model: "b", status: "cancelled", detail: "cancelled by caller" },
    ]) && feed.calls.length === 0,
    JSON.stringify({ results: withoutLatency(results), calls: feed.calls.length }),
  );
}

{
  const signals: AbortSignal[] = [];
  let release: (() => void) | undefined;
  const hang = ((_input: unknown, init?: RequestInit) => {
    signals.push(init?.signal as AbortSignal);
    return new Promise<Response>((resolve) => {
      release = () => resolve(probeResponse({}));
    });
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  const pending = probeModels({ gateway: PROBE_GATEWAY, models: ["a", "b"], signal: controller.signal, timeoutMs: 1000, fetchImpl: hang });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const results = await pending;
  check(
    "中途取消：立刻 cancelled，不被迟到的成功响应洗成 ok，每条 fetch 都拿到 signal",
    same(withoutLatency(results), [
      { model: "a", status: "cancelled", detail: "cancelled by caller" },
      { model: "b", status: "cancelled", detail: "cancelled by caller" },
    ]) && signals.length === 2 && signals.every((signal) => signal.aborted),
    JSON.stringify({ results: withoutLatency(results), signals: signals.length, aborted: signals.map((signal) => signal.aborted) }),
  );
  release?.();
}

{
  const token = "sk-echo-me-4b7e";
  const feed = probeFetch(() => probeResponse({ error: { message: `bad key ${token} accepted` } }, 401));
  const results = await probeModels({ gateway: PROBE_GATEWAY, models: ["m1"], apiKey: token, fetchImpl: feed.impl });
  check(
    "错误体回显密钥时抹成 ***（排障输出不泄露）",
    same(withoutLatency(results), [{ model: "m1", status: "auth", httpStatus: 401, detail: "bad key *** accepted" }]),
    JSON.stringify(withoutLatency(results)),
  );
}

// ── 会话头：core 只管归一化与「每格独立」 ────────────────────────────────
//
// 头名是插件自己的线路契约，不再是调用方传进来的参数：宿主只认识钩子的形状，不认识头名。
// 三个格子各自独立 —— 取得到就写、取不到就省略。「有没有父会话」不再是一道整批门槛：
// 根会话也有自己的 id 和名字，父 id 缺失只代表那一格缺失。
console.log("");
console.log("会话头（归一化与三格独立，头名是 core 自己的线路契约）");

check(
	"三个头名逐字（跨宿主契约只在这里声明一份）",
	same(Object.values(SESSION_HEADERS).sort(), [
		"agentfacade-parent-session-id",
		"agentfacade-session-id",
		"agentfacade-session-name",
	]),
	JSON.stringify(SESSION_HEADERS),
);

check(
	"会话 id：trim → 去控制字符 → 截断到 128（顺序按契约，不是先截断再洗）",
	same(normalizeSessionId(`  pi/sess-1\u0000\u001f\u007f-v2  `), "pi/sess-1-v2") &&
		normalizeSessionId("a".repeat(200)) === "a".repeat(128),
	JSON.stringify(normalizeSessionId(`  pi/sess-1\u0000\u001f\u007f-v2  `)),
);
check(
	"会话 id 长度恰好等于上限（128）时逐字保留，129 才截断",
	normalizeSessionId("a".repeat(128)) === "a".repeat(128) &&
		normalizeSessionId("a".repeat(129)) === "a".repeat(128),
	JSON.stringify([normalizeSessionId("a".repeat(128))?.length, normalizeSessionId("a".repeat(129))?.length]),
);
check(
	"会话 id 全是空白 / 控制字符 / 非字符串 → 未解析（null，不是空串）",
	same([normalizeSessionId(" \t\r\n "), normalizeSessionId("\u0000\u007f"), normalizeSessionId(42), normalizeSessionId(null)], [null, null, null, null]),
	JSON.stringify([normalizeSessionId(" \t\r\n "), normalizeSessionId("\u0000\u007f")]),
);
check(
	"名字只留 [A-Za-z0-9._-]，空则省略，超长截断到 64",
	same(normalizeAgentName("  coder.v2_a-b  "), "coder.v2_a-b") &&
		same(normalizeAgentName("coder!! /中文 name"), "codername") &&
		same(normalizeAgentName("/\\!?"), null) &&
		normalizeAgentName("z".repeat(100)) === "z".repeat(64),
	JSON.stringify([normalizeAgentName("coder!! /中文 name"), normalizeAgentName("z".repeat(100))?.length]),
);
check(
	"名字长度恰好等于上限（64）时逐字保留，65 才截断",
	normalizeAgentName("z".repeat(64)) === "z".repeat(64) &&
		normalizeAgentName("z".repeat(65)) === "z".repeat(64),
	JSON.stringify([normalizeAgentName("z".repeat(64))?.length, normalizeAgentName("z".repeat(65))?.length]),
);
check(
	"三格都取得到 → 逐字三个头（一次给齐；名字那一格叫 sessionName）",
	same(buildSessionHeaders({ sessionId: "  child-1  ", parentSessionId: "parent-9", sessionName: "coder.a" }), {
		"agentfacade-session-id": "child-1",
		"agentfacade-parent-session-id": "parent-9",
		"agentfacade-session-name": "coder.a",
	}),
	JSON.stringify(buildSessionHeaders({ sessionId: "child-1", parentSessionId: "parent-9", sessionName: "coder.a" })),
);
check(
	"父 id 与名字都未解析 → 只写会话 id，绝不写空值 / 编造父 id",
	same(buildSessionHeaders({ sessionId: "child-2", parentSessionId: "", sessionName: "!!!" }), {
		"agentfacade-session-id": "child-2",
	}),
	JSON.stringify(buildSessionHeaders({ sessionId: "child-2", parentSessionId: "", sessionName: "!!!" })),
);
check(
	"根会话（没有父 id 这一格）照样发自己的 id 与名字 —— 不设整批门槛",
	same(buildSessionHeaders({ sessionId: "root-1", sessionName: "coder" }), {
		"agentfacade-session-id": "root-1",
		"agentfacade-session-name": "coder",
	}),
	JSON.stringify(buildSessionHeaders({ sessionId: "root-1", sessionName: "coder" })),
);
check(
	"只有父 id 取得到 → 只写父 id 这一格（三格互不牵连）",
	same(buildSessionHeaders({ parentSessionId: "parent-9" }), { "agentfacade-parent-session-id": "parent-9" }),
	JSON.stringify(buildSessionHeaders({ parentSessionId: "parent-9" })),
);
check(
	"三值全空 → {}（一个头都不写，也不写空头）",
	same(buildSessionHeaders({}), {}) &&
		same(buildSessionHeaders({ sessionId: "", parentSessionId: "   ", sessionName: "///" }), {}) &&
		same(buildSessionHeaders({ sessionId: null, parentSessionId: 42, sessionName: undefined }), {}),
	JSON.stringify([buildSessionHeaders({}), buildSessionHeaders({ sessionId: "", parentSessionId: "   ", sessionName: "///" })]),
);

// ── 归属规则：core 里不许出现 agent 词汇 ─────────────────────────────────────

console.log("");
console.log("core 的归属规则（禁用词扫描）");

{
  // 这条规则平时靠人守，靠人就一定会漏。扫一遍源码是把它变成一条能红的断言
  const FORBIDDEN = [
    "thinkingLevelMap",
    "compat",
    "cordis",
    "/facade-models",
    "PI_FACADE_GATEWAY",
    "FACADE_GATEWAY",
    "opencode",
    "agentfacade",
    "anthropic",
  ];
  // `capabilities` 开了一半口子：它是**网关报文**的键（capabilities.reasoning /
  // capabilities.tools），catalog.ts 必须读它；但它出现在别的 core 文件里、或以 `capabilities:` 的
  // key 位置出现，就说明 agent 的形状漏进了契约。下面那条 key 位置断言是这条口子的补偿。
  const PAYLOAD_ONLY = "capabilities";
  const files = ["types.ts", "catalog.ts", "gateway.ts", "sync.ts", "gateway-config.ts", "auth.ts", "poll.ts", "probe.ts", "session-headers.ts"];
  // 「agentfacade」是工具链自己的目录名/项名：gateway-config.ts 里只许出现在 config.json 路径上，
  // auth.ts 整份文件管的就是 auth.json（路径、项名、报错文案全是它）。
  // 其它文件出现一次就算越界。
  const AGENTFACADE_EXEMPT: Record<string, string | null> = { "gateway-config.ts": "config.json", "auth.ts": null };
  const hits: string[] = [];
  const keyHits: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(CORE_DIR, file), "utf8");
    for (const word of FORBIDDEN) {
      if (word === "agentfacade" && file in AGENTFACADE_EXEMPT) {
        const tail = AGENTFACADE_EXEMPT[file];
        const offender =
          tail === null
            ? undefined
            : text.split("\n").find((line) => line.includes("agentfacade") && !line.includes(tail));
        if (offender !== undefined) hits.push(`${file}: agentfacade outside the ${tail} path`);
        continue;
      }
      if (text.includes(word)) hits.push(`${file}: ${word}`);
    }
    if (file !== "catalog.ts" && text.includes(PAYLOAD_ONLY)) hits.push(`${file}: ${PAYLOAD_ONLY}`);
    if (/(^|[\s,{])capabilities\s*:/m.test(text)) keyHits.push(file);
  }
  check("core 的九个源文件里没有 agent 词汇", hits.length === 0, JSON.stringify(hits));
  check("capabilities 只在读报文的位置，没变成我们自己的字段名", keyHits.length === 0, JSON.stringify(keyHits));
  check(
    "扫描确实读到了九个源文件（不然上一行永远绿）",
    files.every((file) => fs.existsSync(path.join(CORE_DIR, file))),
    JSON.stringify(files),
  );
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 条）` : `${fail} 条失败，${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
