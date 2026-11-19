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
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  modelsFromPayload,
  normalizeEfforts,
  normalizeReasoning,
  toModelSpec,
} from "../catalog.ts";
import {
  DEFAULT_TIMEOUT_MS,
  fetchCatalog,
  fetchModelList,
  modelsUrl,
  resolveGateway,
} from "../gateway.ts";
import { syncCatalog, type SyncDeps, type SyncState } from "../sync.ts";
import type { HostAdapter, ModelSpec } from "../types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.join(HERE, "..");

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

console.log("toModelSpec（逐字快照）");

check(
  "完整字段原样搬过来",
  same(toModelSpec({
    id: "model-01",
    display_name: "Model 01",
    reasoning: true,
    effort_options: ["off", "low", "high", "max"],
    context_window: 1000000,
    max_output_tokens: 384000,
  }), {
    id: "model-01",
    displayName: "Model 01",
    reasoning: true,
    efforts: ["off", "low", "high", "max"],
    contextWindow: 1000000,
    maxOutputTokens: 384000,
  }),
  JSON.stringify(toModelSpec({ id: "x" })),
);

check(
  "context_window / max_output_tokens 缺失 → 200000 / 4096",
  same(toModelSpec({ id: "no-limits" }), {
    id: "no-limits",
    displayName: "no-limits",
    reasoning: true,
    efforts: [],
    contextWindow: 200000,
    maxOutputTokens: 4096,
  }),
  JSON.stringify(toModelSpec({ id: "no-limits" })),
);

check(
  "导出的缺省值常量就是 200000 / 4096（宿主不该各写一份）",
  DEFAULT_CONTEXT_WINDOW === 200000 && DEFAULT_MAX_OUTPUT_TOKENS === 4096,
  `${DEFAULT_CONTEXT_WINDOW}/${DEFAULT_MAX_OUTPUT_TOKENS}`,
);

check(
  "上限写 0 也算「没说」（0 是网关表达没填的方式，不是零窗口）",
  toModelSpec({ id: "zeros", context_window: 0, max_output_tokens: 0 }).contextWindow === 200000 &&
    toModelSpec({ id: "zeros", context_window: 0, max_output_tokens: 0 }).maxOutputTokens === 4096,
  JSON.stringify(toModelSpec({ id: "zeros", context_window: 0, max_output_tokens: 0 })),
);

check(
  "上限是数字字符串也认（网关有些字段是字符串）",
  toModelSpec({ id: "s", context_window: "131072", max_output_tokens: "32768" }).contextWindow === 131072,
  String(toModelSpec({ id: "s", context_window: "131072" }).contextWindow),
);

check(
  "display_name 缺失或为空 → displayName 用 id",
  toModelSpec({ id: "bare" }).displayName === "bare" && toModelSpec({ id: "blank", display_name: "" }).displayName === "blank",
  JSON.stringify([toModelSpec({ id: "bare" }).displayName, toModelSpec({ id: "blank", display_name: "" }).displayName]),
);

check(
  "reasoning 未声明 → true（不知道不等于不支持）",
  toModelSpec({ id: "mystery" }).reasoning === true,
  String(toModelSpec({ id: "mystery" }).reasoning),
);

check(
  "reasoning 不是布尔（比如字符串）也按「不知道」→ true，不当成 false",
  toModelSpec({ id: "wobbly", reasoning: "yes" }).reasoning === true,
  JSON.stringify(toModelSpec({ id: "wobbly", reasoning: "yes" }).reasoning),
);

check(
  "reasoning: false 保留 false",
  toModelSpec({ id: "flat", reasoning: false }).reasoning === false,
  String(toModelSpec({ id: "flat", reasoning: false }).reasoning),
);

check(
  "档位原样：不排序、不改拼写、不去重",
  same(toModelSpec({ id: "e", effort_options: ["high", "off", "midium", "high"] }).efforts, ["high", "off", "midium", "high"]),
  JSON.stringify(toModelSpec({ id: "e", effort_options: ["high", "off", "midium", "high"] }).efforts),
);

check(
  "档位缺省 → 空数组（不补 off、不补任何一档）",
  same(toModelSpec({ id: "e" }).efforts, []),
  JSON.stringify(toModelSpec({ id: "e" }).efforts),
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

console.log("");
console.log("modelsFromPayload");

check(
  "没有 id 的项跳过",
  same(modelsFromPayload([{ id: "" }, { display_name: "no id" }, { id: "kept" }]).map((m) => m.id), ["kept"]),
  JSON.stringify(modelsFromPayload([{ id: "" }, { display_name: "no id" }, { id: "kept" }])),
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
      config: { label: "config file", read: () => "http://from-config.example:6450/" },
      fallback: "http://fallback.example:6450",
    }),
    { ok: true, gateway: "http://from-config.example:6450", from: "config file" },
  ),
  JSON.stringify(
    resolveGateway({
      candidates: [{ from: "FIRST", value: "" }],
      config: { label: "config file", read: () => "http://from-config.example:6450/" },
      fallback: "http://fallback.example:6450",
    }),
  ),
);

check(
  "配置文件里的地址写错也报错，不悄悄用默认值",
  same(
    resolveGateway({
      candidates: [],
      config: { label: "config file", read: () => "file:///etc/passwd" },
      fallback: "http://fallback.example:6450",
    }),
    { ok: false, error: "config file gateway is not an http(s) URL: file:///etc/passwd" },
  ),
  JSON.stringify(
    resolveGateway({
      candidates: [],
      config: { label: "config file", read: () => "file:///etc/passwd" },
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

check("模型清单地址是根路径下的 /v1/models", modelsUrl("http://gw.example:6450") === "http://gw.example:6450/v1/models", modelsUrl("http://gw.example:6450"));

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
    "打的是 {gateway}/v1/models，GET + accept: application/json",
    same(calls, [{ url: "http://gw.example:6450/v1/models", method: "GET", accept: "application/json" }]),
    JSON.stringify(calls),
  );
}

{
  const { impl } = captureFetch(() => new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" } }));
  const listed = await fetchModelList("http://gw.example:6450", { fetchImpl: impl });
  check(
    "非 JSON 报「did not answer a JSON object」",
    !listed.ok && (listed as { error: string }).error === 'http://gw.example:6450/v1/models did not answer a JSON object',
    JSON.stringify(listed),
  );
}

{
  const { impl } = captureFetch(() => jsonResponse({ object: "list" }));
  const listed = await fetchModelList("http://gw.example:6450", { fetchImpl: impl });
  check(
    "没有 data 那一格报「no \"data\" list」而不是当成空清单",
    !listed.ok && (listed as { error: string }).error === 'http://gw.example:6450/v1/models has no "data" list',
    JSON.stringify(listed),
  );
}

{
  const { impl } = captureFetch(() => jsonResponse({ error: "boom" }, 500));
  const listed = await fetchModelList("http://gw.example:6450", { fetchImpl: impl });
  check(
    "HTTP 500 报状态码",
    !listed.ok && (listed as { error: string }).error === "http://gw.example:6450/v1/models answered HTTP 500",
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
        "http://gw.example:6450/v1/models unreachable: connect ECONNREFUSED 127.0.0.1:6450",
    JSON.stringify(listed),
  );
}

{
  const started = Date.now();
  const listed = await fetchModelList("http://gw.example:6450", { timeoutMs: 150, fetchImpl: hangFetch });
  const elapsed = Date.now() - started;
  check(
    "永不响应的上游按超时报失败",
    !listed.ok && (listed as { error: string }).error === "http://gw.example:6450/v1/models timed out after 150ms",
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
  const { impl } = captureFetch(() => jsonResponse({ data: [{ id: "model-01", display_name: "Model 01" }] }));
  const catalog = await fetchCatalog("http://gw.example:6450", { fetchImpl: impl });
  check(
    "fetchCatalog 交出归一化后的 ModelSpec（逐字）",
    same(catalog, {
      ok: true,
      specs: [
        {
          id: "model-01",
          displayName: "Model 01",
          reasoning: true,
          efforts: [],
          contextWindow: 200000,
          maxOutputTokens: 4096,
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
    same(catalog, { ok: false, cancelled: false, error: "http://gw.example:6450/v1/models listed no models" }),
    JSON.stringify(catalog),
  );
}

{
  // 有 data 但每条都没有 id：归一化后是 0 条，同样不能当成「有清单」
  const { impl } = captureFetch(() => jsonResponse({ data: [{ display_name: "no id" }] }));
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

/** 宿主只需要给两样：地址怎么解析、自己的模型形状怎么生成 */
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
    "首次成功：交回宿主形状的清单",
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
      error: "http://gw.example:6450/v1/models unreachable: connect ECONNREFUSED",
      models: ["model-01", "model-02"],
    }),
    JSON.stringify(outcome),
  );
  check("失败时 lastGood 一个元素都没动（同一个数组）", state.lastGood === before, JSON.stringify(state.lastGood));
  check("失败时 lastRefresh 不动（还显示上一次成功的时间）", state.lastRefresh === 1700000000000, String(state.lastRefresh));
  check("失败时 lastError 写明原因", state.lastError === "http://gw.example:6450/v1/models unreachable: connect ECONNREFUSED", String(state.lastError));
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
    state.lastError === "http://gw.example:6450/v1/models listed no models",
    String(state.lastError),
  );
}

{
  // 宿主的映射一条都没产出（字段全不认识）：同样不能替换
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
    same(outcome, { ok: false, cancelled: true, error: "http://gw.example:6450/v1/models cancelled", models: ["model-01"] }),
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
  check("core 自己不碰 registered 标志（注册是宿主的事）", state.registered === false, String(state.registered));
}

// ── 跨宿主契约 ───────────────────────────────────────────────────────────

console.log("");
console.log("HostAdapter 契约");

{
  // 一个最小的适配器：只用来钉住契约的形状 —— 任何宿主实现长出额外的必需成员，
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

// ── 归属规则：core 里不许出现宿主词汇 ─────────────────────────────────────

console.log("");
console.log("core 的归属规则（禁用词扫描）");

{
  // 这条规则平时靠人守，靠人就一定会漏。扫一遍源码是把它变成一条能红的断言
  const FORBIDDEN = [
    "thinkingLevelMap",
    "capabilities",
    "compat",
    "cordis",
    "/facade-models",
    "PI_FACADE_GATEWAY",
    "FACADE_GATEWAY",
    "opencode",
    "agentfacade",
    "anthropic",
  ];
  const files = ["types.ts", "catalog.ts", "gateway.ts", "sync.ts"];
  const hits: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(CORE_DIR, file), "utf8");
    for (const word of FORBIDDEN) {
      if (text.includes(word)) hits.push(`${file}: ${word}`);
    }
  }
  check("core 的四个源文件里没有宿主词汇", hits.length === 0, JSON.stringify(hits));
  check(
    "扫描确实读到了四个源文件（不然上一行永远绿）",
    files.every((file) => fs.existsSync(path.join(CORE_DIR, file))),
    JSON.stringify(files),
  );
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 条）` : `${fail} 条失败，${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
