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
import {
  DEFAULT_GATEWAY,
  normalizeGatewayInput,
  resolveFacadeGateway,
  writeFacadeConfig,
} from "../gateway-config.ts";
import { syncCatalog, type SyncDeps, type SyncState } from "../sync.ts";
import type { HostAdapter, ModelSpec } from "../types.ts";

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

/** 注入用的假 fetch：记录被请求的地址/方法/accept，回答由 respond 决定 */
function captureFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string; accept: string }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "", accept: headers.accept ?? "" });
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
  const files = ["types.ts", "catalog.ts", "gateway.ts", "sync.ts", "gateway-config.ts"];
  const hits: string[] = [];
  const keyHits: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(CORE_DIR, file), "utf8");
    for (const word of FORBIDDEN) {
      // gateway-config.ts 里的 "agentfacade" 只允许出现在配置文件路径（~/.config/agentfacade/config.json）
      // —— 那是工具链自己的目录名。豁免判定按行：该行必须同时提到 config.json，出现在别处照样算越界
      if (word === "agentfacade" && file === "gateway-config.ts") {
        const offender = text.split("\n").find((line) => line.includes("agentfacade") && !line.includes("config.json"));
        if (offender !== undefined) hits.push(`${file}: agentfacade outside the config path`);
        continue;
      }
      if (text.includes(word)) hits.push(`${file}: ${word}`);
    }
    if (file !== "catalog.ts" && text.includes(PAYLOAD_ONLY)) hits.push(`${file}: ${PAYLOAD_ONLY}`);
    if (/(^|[\s,{])capabilities\s*:/m.test(text)) keyHits.push(file);
  }
  check("core 的五个源文件里没有 agent 词汇", hits.length === 0, JSON.stringify(hits));
  check("capabilities 只在读报文的位置，没变成我们自己的字段名", keyHits.length === 0, JSON.stringify(keyHits));
  check(
    "扫描确实读到了五个源文件（不然上一行永远绿）",
    files.every((file) => fs.existsSync(path.join(CORE_DIR, file))),
    JSON.stringify(files),
  );
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 条）` : `${fail} 条失败，${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
