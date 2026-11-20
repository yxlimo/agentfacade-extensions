// test/check.ts — opencode agent（**v2 插件 API**）的自检。
//
//   node --experimental-strip-types hosts/opencode/test/check.ts
//
// 覆盖这些块：
//   · 映射：ModelSpec → v2 的 `Model.Info`；整份清单 → `editor.add()` 的入参。期望值里有手写快照
//     （fixtures/expected.ts），由 SNAPSHOT_SPECS 人工推导，逐字比对
//   · setup：成功时 `add` 调一次；网关不可达 / 空清单 / 非 JSON / 地址写错时**一次都不调**，
//     只在 stderr 留一行警告（用户原有配置继续生效）
//   · 空清单绝不替换上一次的清单（core 的状态机，从这一侧也钉一遍）
//   · 网关地址：OPENCODE_FACADE_GATEWAY > FACADE_GATEWAY > 配置文件 > 默认
//   · 归属规则：这一层不碰网关协议，也没有任何写文件的 API
//
// 全部离线：网络用注入的 fetch 伪造（不起端口、不连真网关），配置文件用临时主目录。
// 期望值一律手写并逐字比对，不写「是对象」「是数组」这种断言 —— 那种断言在映射改坏后照样绿。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FetchOptions } from "../../../core/gateway.ts";
import type { ModelSpec } from "../../../core/types.ts";
import type { PollerTimers } from "../../../core/poll.ts";
import { API_KEY, PROVIDER_ID, PROVIDER_NAME, providerBaseUrl } from "../catalog.ts";
import plugin, {
  PLUGIN_ID,
  freshState,
  refresh,
  setup,
  type OpencodePluginOptions,
  type OpencodeV2Context,
} from "../index.ts";
import { DEFAULT_PACKAGE, toV2Model, toV2Payload, type OpencodeV2Payload } from "../v2.ts";
import {
  DEFAULT_GATEWAY,
  DEFAULT_TIMEOUT_MS,
  GATEWAY_ENV_VARS,
  resolveGateway,
} from "../gateway-config.ts";
import { EXPECTED } from "../fixtures/expected.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_DIR = path.join(HERE, "..");

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

/**
 * 断言失败时的详情文本。
 *
 * 不能直接写 `JSON.stringify(x).slice(0, 200)`：`JSON.stringify(undefined)` 返回 undefined，
 * 于是 detail 表达式自己抛 TypeError，整个用例挂掉 —— 失败信息反而把后面的断言全遮住了。
 */
function brief(value: unknown, max = 260): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.slice(0, max);
}

/** 临时主目录：配置文件那一级从这里读，绝不读真实 ~/.config */
function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-v2-models-home-"));
}

/** 注入用的假 fetch：记录被请求的地址，回答由 respond 决定 */
/** 注入用的假 fetch：记录被请求的地址与 init（请求头是 init 的一格，鉴权靠它钉），回答由 respond 决定 */
function captureFetch(respond: (url: string) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: string[];
  inits: (RequestInit | undefined)[];
} {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push(String(input));
    inits.push(init);
    return respond(String(input));
  }) as unknown as typeof fetch;
  return { impl, calls, inits };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 永不响应的上游：只有 abort 才有反应。超时那条路靠它 */
const hangFetch = (async (_input: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as unknown as typeof fetch;

/**
 * v2 的 agent 上下文。我们只用到 `provider.transform` 一格：它把 callback 交给我们，callback 里
 * 拿到一个只有 `add` 的 editor。真机是 opencode 自己构造这两个对象，这里记下被交进去的入参。
 */
function fakeContext(): {
  ctx: OpencodeV2Context;
  added: OpencodeV2Payload[];
  transforms: () => number;
} {
  const added: OpencodeV2Payload[] = [];
  let calls = 0;
  const ctx: OpencodeV2Context = {
    provider: {
      async transform(callback) {
        calls += 1;
        callback({
          add: (entry: OpencodeV2Payload) => {
            added.push(entry);
          },
        });
      },
    },
  };
  return { ctx, added, transforms: () => calls };
}

/**
 * 假定时器：`set` 只记下挂起的回调与间隔，`fire` 手动触发一轮。
 *
 * 轮询器每轮 tick 末尾都会重新挂定时器（除非被 stop），所以「pending 重新出现」
 * 就是这一轮（含 refresh 与 apply）跑完的信号 —— 比等若干毫秒更确定，也不受真时钟影响。
 */
function fakeTimers(): {
  timers: PollerTimers;
  /** 触发当前挂起的定时器，等这一轮 tick（含 refresh 与 apply）跑完 */
  fire: () => Promise<void>;
  /** 最近一次 set 拿到的间隔 */
  lastMs: () => number;
} {
  let pending: (() => void) | null = null;
  let lastMs = 0;
  const timers: PollerTimers = {
    set(handler, ms) {
      lastMs = ms;
      pending = handler;
      return { unref() {} };
    },
    clear() {
      pending = null;
    },
  };
  const fire = async (): Promise<void> => {
    const current = pending;
    pending = null;
    if (current === null) return;
    current();
    // tick 是异步的：等到它末尾重新挂上定时器，就是这轮跑完了
    const deadline = Date.now() + 2000;
    while (pending === null) {
      if (Date.now() > deadline) throw new Error("the poller did not re-arm after firing");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  return { timers, fire, lastMs: () => lastMs };
}

const GATEWAY = "http://gateway.example:6450";
/**
 * 「主机 + 路径」，去掉 query。
 *
 * 清单地址上挂什么方言（`?dialect=` 之类）是 core 的事：agent 这一层钉整条 URL，core 换个
 * 方言这一层就红 —— 那不是 agent 的行为变了。所以这里只钉打到哪台机器的哪条路径。
 */
function listTarget(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** 跑一遍 setup，返回 editor.add 收到了什么。env/home 都可注入，绝不碰真实环境 */
async function runSetup(options: {
  env?: Record<string, string>;
  fetchOptions?: FetchOptions;
  pluginOptions?: OpencodePluginOptions;
} = {}): Promise<{ added: OpencodeV2Payload[]; transforms: number; warnings: string[] }> {
  const warnings: string[] = [];
  const { ctx, added, transforms } = fakeContext();
  await setup(ctx, {
    env: options.env ?? {},
    home: tempHome(),
    fetchOptions: options.fetchOptions ?? {},
    warn: (message: string) => warnings.push(message),
    ...options.pluginOptions,
  });
  return { added, transforms: transforms(), warnings };
}

/**
 * 一条 ModelSpec 的构造器：只写这条用例关心的字段，其余按「网关没报」的默认值。
 *
 * 默认值不是断言（下面每处断言仍然逐字写出期望结果）；它存在的理由只是 ModelSpec 有
 * 八格，而一条用例通常只关心其中两三格。注意 `toolCall: null` 与 `modalities: null`
 * 是「网关没说」，**不是** false / 空数组 —— 这两格的差别是本 agent 唯一要做选择的地方。
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

const SPEC: ModelSpec = {
  id: "model-01",
  displayName: "Model 01",
  reasoning: true,
  efforts: ["off", "low", "high", "max"],
  contextWindow: 1000000,
  maxOutputTokens: 384000,
  // 网关这一版报的三项：能调工具、模态是 text+image、价格本 agent 不表达
  toolCall: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  cost: null,
};

/**
 * 假网关的回答：一条模型，**只给 id**。
 *
 * agent 的义务到 ModelSpec 为止；条目里其余字段长什么样是 core 的事（形状只留一份），
 * 这样网关改渲染时这一层不会被拖下水。注册路径要验的是「拉到了、注册了一次」。
 */
const ONE_LISTED = {
  object: "list",
  data: [{ id: "model-01" }],
};

/** 上面那份回答注册出去必须长成这样（手写，不由 toV2Payload 生成） */
const ONE_PAYLOAD: OpencodeV2Payload = {
  info: {
    id: "agentfacade",
    name: "AgentFacade (main route)",
    activation: "enabled",
    package: "@opencode/ai/providers/anthropic",
    settings: { baseURL: `${GATEWAY}/v1`, apiKey: "public" },
  },
  models: [
    {
      id: "model-01",
      modelID: "model-01",
      providerID: "agentfacade",
      // 只有 id 的条目：名字退回 id、窗口 200000/4096（core 的缺省值），
      // tools 为 true（toolCall=null 时本 agent 按支持）、模态是录制里的常量
      name: "model-01",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 200000, output: 4096 },
    },
  ],
};

// ── 映射：一条 ModelSpec ─────────────────────────────────────────────────

console.log("toV2Model（逐字快照）");

check(
  "一条 ModelSpec 逐字搬成 v2 的 Model.Info",
  same(toV2Model(SPEC), {
    id: "model-01",
    modelID: "model-01",
    providerID: "agentfacade",
    name: "Model 01",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1000000, output: 384000 },
  }),
  brief(toV2Model(SPEC)),
);

check(
  "name 用 displayName，不是裸 id（v2 默认给的是裸 id，选择器里全是机器名）",
  toV2Model({ ...SPEC, id: "coder-a", displayName: "Coder A" }).name === "Coder A" &&
    toV2Model({ ...SPEC, id: "coder-a", displayName: "Coder A" }).name !== "coder-a",
  brief(toV2Model({ ...SPEC, id: "coder-a", displayName: "Coder A" }).name),
);

check(
  "id 与 modelID 都是 spec.id（v2 用这两格拼模型引用）",
  toV2Model(SPEC).id === SPEC.id && toV2Model(SPEC).modelID === SPEC.id,
  brief({ id: toV2Model(SPEC).id, modelID: toV2Model(SPEC).modelID }),
);

check(
  "providerID 默认是 provider 键 agentfacade",
  toV2Model(SPEC).providerID === PROVIDER_ID,
  toV2Model(SPEC).providerID,
);

check(
  "providerID 可以被调用方传的键覆盖",
  toV2Model(SPEC, "other").providerID === "other",
  toV2Model(SPEC, "other").providerID,
);

check(
  "limit 用 core 归一后的 contextWindow / maxOutputTokens（不在这里算缺省值）",
  same(toV2Model({ ...SPEC, contextWindow: 131072, maxOutputTokens: 32768 }).limit, {
    context: 131072,
    output: 32768,
  }),
  brief(toV2Model({ ...SPEC, contextWindow: 131072, maxOutputTokens: 32768 }).limit),
);

check(
  "capabilities 逐字（tools / input / output）",
  same(toV2Model(SPEC).capabilities, { tools: true, input: ["text", "image"], output: ["text"] }),
  brief(toV2Model(SPEC).capabilities),
);

// 工具：网关说「不能」照它；说「不知道」（null）时本 agent 按支持 —— 这是 agent 的选择
check(
  "toolCall=false → capabilities.tools 为 false（网关明确说不能调工具）",
  toV2Model({ ...SPEC, toolCall: false }).capabilities.tools === false,
  brief(toV2Model({ ...SPEC, toolCall: false }).capabilities),
);
check(
  "toolCall=null → capabilities.tools 为 true（不知道不等于不能，与 pi 的缺省一致）",
  toV2Model({ ...SPEC, toolCall: null }).capabilities.tools === true,
  brief(toV2Model({ ...SPEC, toolCall: null }).capabilities),
);
check(
  "toolCall=true → capabilities.tools 为 true",
  toV2Model({ ...SPEC, toolCall: true }).capabilities.tools === true,
  brief(toV2Model({ ...SPEC, toolCall: true }).capabilities),
);

// 模态：网关报了就以它为准（哪怕只有一个、或一个都不收）；没报才退回录制里的常量
check(
  "modalities 有值就用它（不再套录制常量）",
  same(toV2Model({ ...SPEC, modalities: { input: ["text"], output: ["text"] } }).capabilities, {
    tools: true,
    input: ["text"],
    output: ["text"],
  }),
  brief(toV2Model({ ...SPEC, modalities: { input: ["text"], output: ["text"] } }).capabilities),
);
check(
  "modalities 是空数组也照它（input: [] 是网关断言「一个模态都不收」，不是没报）",
  same(toV2Model({ ...SPEC, modalities: { input: [], output: [] } }).capabilities, {
    tools: true,
    input: [],
    output: [],
  }),
  brief(toV2Model({ ...SPEC, modalities: { input: [], output: [] } }).capabilities),
);
check(
  "modalities=null（网关没报）→ 退回录制里的常量 text+image / text",
  same(toV2Model({ ...SPEC, modalities: null }).capabilities, {
    tools: true,
    input: ["text", "image"],
    output: ["text"],
  }),
  brief(toV2Model({ ...SPEC, modalities: null }).capabilities),
);
check(
  "从 spec 取来的模态数组不是同一个引用（改一条不该污染下一条，也不该改调用方的 spec）",
  (() => {
    const source: ModelSpec = { ...SPEC, modalities: { input: ["text"], output: ["text"] } };
    const first = toV2Model(source);
    first.capabilities.input.push("audio");
    return source.modalities!.input.length === 1 && toV2Model(source).capabilities.input.length === 1;
  })(),
  brief(toV2Model(SPEC).capabilities),
);

check(
  "variants 恒为空数组：上游有 4 个档位也不往里塞（形状未公开，不发明）",
  toV2Model(SPEC).variants.length === 0 && SPEC.efforts.length === 4,
  brief(toV2Model(SPEC).variants),
);

check(
  "固定尾巴：status / enabled / time / cost",
  same(
    {
      status: toV2Model(SPEC).status,
      enabled: toV2Model(SPEC).enabled,
      time: toV2Model(SPEC).time,
      cost: toV2Model(SPEC).cost,
    },
    { status: "active", enabled: true, time: { released: 0 }, cost: [] },
  ),
  brief(toV2Model(SPEC)),
);

{
  // 每次都要新建数组：就地改一条模型的 capabilities 不该污染下一条（共享常量会这么做）
  const first = toV2Model(SPEC);
  first.capabilities.input.push("audio");
  check("capabilities 的数组不是共享常量", toV2Model(SPEC).capabilities.input.length === 2, brief(toV2Model(SPEC).capabilities.input));
}

// ── baseURL 拼法 ─────────────────────────────────────────────────────────

console.log("");
console.log("providerBaseUrl（baseURL 末尾斜杠归一，并补上 /v1）");

check(
  "根地址 → 带 /v1",
  providerBaseUrl("http://gw.example:6450") === "http://gw.example:6450/v1",
  providerBaseUrl("http://gw.example:6450"),
);
check(
  "末尾一个斜杠 → 不变 …//v1",
  providerBaseUrl("http://gw.example:6450/") === "http://gw.example:6450/v1",
  providerBaseUrl("http://gw.example:6450/"),
);
check(
  "末尾三个斜杠也归一",
  providerBaseUrl("http://gw.example:6450///") === "http://gw.example:6450/v1",
  providerBaseUrl("http://gw.example:6450///"),
);
check(
  "两端空白与斜杠一起归一",
  providerBaseUrl("  http://gw.example:6450/  ") === "http://gw.example:6450/v1",
  providerBaseUrl("  http://gw.example:6450/  "),
);

// ── 映射：整份清单 ───────────────────────────────────────────────────────

console.log("");
console.log("toV2Payload（整份 payload）");

const PAYLOAD = toV2Payload([SPEC], { baseUrl: GATEWAY, apiKey: API_KEY });

check(
  "整份 payload 逐字相同（info + 一条模型）",
  same(PAYLOAD, {
    info: {
      id: "agentfacade",
      name: "AgentFacade (main route)",
      activation: "enabled",
      package: "@opencode/ai/providers/anthropic",
      settings: { baseURL: "http://gateway.example:6450/v1", apiKey: "public" },
    },
    models: [
      {
        id: "model-01",
        modelID: "model-01",
        providerID: "agentfacade",
        name: "Model 01",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 1000000, output: 384000 },
      },
    ],
  }),
  brief(PAYLOAD),
);

check("info.id 是 agentfacade", PAYLOAD.info.id === "agentfacade" && PAYLOAD.info.id === PROVIDER_ID, PAYLOAD.info.id);
check("info.activation 是 enabled（不写就是 auto 的语义）", PAYLOAD.info.activation === "enabled", PAYLOAD.info.activation);
check(
  "package 默认是 DEFAULT_PACKAGE（实测能用的那个）",
  PAYLOAD.info.package === DEFAULT_PACKAGE && DEFAULT_PACKAGE === "@opencode/ai/providers/anthropic",
  PAYLOAD.info.package,
);
check(
  "pkg 选项能覆盖 package（换方言的旋钮）",
  toV2Payload([SPEC], { baseUrl: GATEWAY, apiKey: API_KEY, pkg: "@opencode/ai/providers/openai-compatible" }).info
    .package === "@opencode/ai/providers/openai-compatible",
  toV2Payload([SPEC], { baseUrl: GATEWAY, apiKey: API_KEY, pkg: "x" }).info.package,
);
check("info.name 默认是 PROVIDER_NAME", PAYLOAD.info.name === PROVIDER_NAME, PAYLOAD.info.name);
check(
  "displayName 选项覆盖 info.name",
  toV2Payload([SPEC], { baseUrl: GATEWAY, apiKey: API_KEY, displayName: "Fake" }).info.name === "Fake",
  toV2Payload([SPEC], { baseUrl: GATEWAY, apiKey: API_KEY, displayName: "Fake" }).info.name,
);
check("settings.baseURL 以 /v1 结尾", PAYLOAD.info.settings.baseURL.endsWith("/v1"), PAYLOAD.info.settings.baseURL);
check(
  "settings.baseURL 里不出现 //v1（AI SDK 不会替我们归一）",
  !PAYLOAD.info.settings.baseURL.includes("//v1"),
  PAYLOAD.info.settings.baseURL,
);
check(
  "网关地址带末尾斜杠时也不出现 //v1",
  !toV2Payload([SPEC], { baseUrl: `${GATEWAY}///`, apiKey: API_KEY }).info.settings.baseURL.includes("//v1"),
  toV2Payload([SPEC], { baseUrl: `${GATEWAY}///`, apiKey: API_KEY }).info.settings.baseURL,
);
check("settings.apiKey 原样交给 settings", PAYLOAD.info.settings.apiKey === "public" && API_KEY === "public", PAYLOAD.info.settings.apiKey);
check(
  "models.length 与输入一致，顺序也一致（数组，不是按 id 键控的表）",
  same(
    toV2Payload([SPEC, { ...SPEC, id: "model-02" }], { baseUrl: GATEWAY, apiKey: API_KEY }).models.map((m) => m.id),
    ["model-01", "model-02"],
  ),
  brief(toV2Payload([SPEC, { ...SPEC, id: "model-02" }], { baseUrl: GATEWAY, apiKey: API_KEY }).models.map((m) => m.id)),
);
check(
  "空 specs 交出的仍是一条完整 provider（core 不许走到这里，形状也不能残缺）",
  same(toV2Payload([], { baseUrl: GATEWAY, apiKey: API_KEY }).models, []) &&
    toV2Payload([], { baseUrl: GATEWAY, apiKey: API_KEY }).info.id === "agentfacade",
  brief(toV2Payload([], { baseUrl: GATEWAY, apiKey: API_KEY })),
);

// ── setup：成功 ──────────────────────────────────────────────────────────

console.log("");
console.log("setup（v2 的注册路径）：成功");

{
  const { impl, calls } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { added, transforms, warnings } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: impl },
  });
  check("成功时 transform 只调一次", transforms === 1, String(transforms));
  check("成功时 editor.add 只调一次", added.length === 1, String(added.length));
  check("注册的 payload 与手写快照逐字相同", same(added[0], ONE_PAYLOAD), brief(added[0]));
  check("成功时没有警告", warnings.length === 0, JSON.stringify(warnings));
  check(
    "只打一次 {gateway}/v1/models（不重试、不并发扫多个地址）",
    same(calls.map(listTarget), [`${GATEWAY}/v1/models`]),
    JSON.stringify(calls),
  );
}

// ── setup：失败路径一律不注册 ────────────────────────────────────────────

console.log("");
console.log("setup：失败路径不注册（用户配置继续生效）");

{
  const failing = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6450");
  }) as unknown as typeof fetch;

  // 走默认的警告通道（不传 warn）：这条要钉住「stderr 上真的有一行」
  const chunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;

  let result: { added: OpencodeV2Payload[]; transforms: number };
  try {
    result = await runSetup({
      env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
      fetchOptions: { fetchImpl: failing },
      pluginOptions: { warn: undefined },
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  const stderr = chunks.join("");

  check("网关不可达时**不注册**（add 一次都没调）", result.added.length === 0, String(result.added.length));
  check("网关不可达时连 transform 都不调", result.transforms === 0, String(result.transforms));
  check("默认警告写到 stderr，并带上前缀", stderr.includes("[facade-models]") && stderr.includes("unreachable"), stderr);
  check(
    "警告写明「没有注册 provider agentfacade」",
    stderr.includes(`not registering provider "${PROVIDER_ID}"`),
    stderr,
  );
  check("警告说明用户自己的 providers 继续生效", stderr.includes("keep working"), stderr);
  check(
    "显式设了网关时不出现默认地址那句（那是踩默认地址时才该说的话）",
    !stderr.includes("no gateway configured"),
    stderr,
  );
}

{
  const { impl } = captureFetch(() => jsonResponse({ data: [] }));
  const { added, transforms, warnings } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: impl },
  });
  check("网关回空清单时不注册（空表等于把用户的模型清空）", added.length === 0 && transforms === 0, String(added.length));
  check("空清单的警告说 listed no models", warnings.some((w) => w.includes("listed no models")), JSON.stringify(warnings));
}

{
  const { impl } = captureFetch(
    () => new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" } }),
  );
  const { added, warnings } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: impl },
  });
  check("答的不是 JSON 时不注册", added.length === 0, String(added.length));
  check(
    "非 JSON 的警告点明「did not answer a JSON object」",
    warnings.some((w) => w.includes("did not answer a JSON object")),
    JSON.stringify(warnings),
  );
}

{
  // 地址写错：一次请求都不该发出去
  const { impl, calls } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { added, warnings } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: "ftp://nope" },
    fetchOptions: { fetchImpl: impl },
  });
  check("地址不是 http(s) 时一次请求都没发", calls.length === 0, JSON.stringify(calls));
  check("地址非法时不注册", added.length === 0, String(added.length));
  check(
    "地址非法时警告点名是哪个变量写错了",
    warnings.some((w) => w.includes("OPENCODE_FACADE_GATEWAY") && w.includes("http(s)")),
    JSON.stringify(warnings),
  );
}

{
  // 什么都没配：试默认网关，并在警告里说清怎么指别处
  const { impl, calls } = captureFetch(() => {
    throw new Error("connect ECONNREFUSED");
  });
  const { added, warnings } = await runSetup({ fetchOptions: { fetchImpl: impl } });
  check("什么都没配时去试默认网关", same(calls.map(listTarget), [`${DEFAULT_GATEWAY}/v1/models`]), JSON.stringify(calls));
  check("默认网关连不上时不注册", added.length === 0, String(added.length));
  check(
    "默认地址连不上时警告带地址、环境变量名与配置文件路径",
    warnings.some(
      (w) =>
        w.includes(DEFAULT_GATEWAY) &&
        w.includes("OPENCODE_FACADE_GATEWAY") &&
        w.includes("agentfacade/config.json"),
    ),
    JSON.stringify(warnings),
  );
}

// ── setup：超时预算 ──────────────────────────────────────────────────────

console.log("");
console.log("setup：超时预算（opencode 启动路径上被 await 的那个数）");

{
  // 不传 timeoutMs：这一侧必须把 DEFAULT_TIMEOUT_MS 传下去。漏了就会吃 core 的 5 秒默认值，
  // 网关「连得上但不回话」时 opencode 启动多等 3.5 秒 —— 那是用户能感觉到的差别。
  const started = Date.now();
  const { added, warnings } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: hangFetch },
  });
  const elapsed = Date.now() - started;
  check("网关不响时不注册", added.length === 0, String(added.length));
  check(
    "超时预算是 1500ms（agent 把自己的预算传了下去，不是 core 的 5 秒）",
    warnings.some((w) => w.includes("timed out after 1500ms")),
    JSON.stringify(warnings),
  );
  check(`超时被遵守（${elapsed}ms，上限 1500ms + 余量）`, elapsed >= 1400 && elapsed < 4000, `${elapsed}ms`);
}

{
  const { impl } = captureFetch(() => jsonResponse({ error: "boom" }, 500));
  const { added, warnings } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: impl },
  });
  check("HTTP 500 时不注册", added.length === 0, String(added.length));
  check("HTTP 500 的警告带状态码", warnings.some((w) => w.includes("HTTP 500")), JSON.stringify(warnings));
}

{
  // 调用方给的预算优先：排查时把 1500ms 调小，不该被这一侧的默认值盖掉
  const { warnings } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: hangFetch, timeoutMs: 120 },
  });
  check(
    "fetchOptions.timeoutMs 覆盖默认的 1500ms",
    warnings.some((w) => w.includes("timed out after 120ms")),
    JSON.stringify(warnings),
  );
}

// ── setup：选项 ──────────────────────────────────────────────────────────

console.log("");
console.log("setup：pkg / displayName 选项");

{
  const { impl } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { added } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: impl },
    pluginOptions: { pkg: "@opencode/ai/providers/openai-compatible", displayName: "Fake Route" },
  });
  check(
    "pkg 选项覆盖 DEFAULT_PACKAGE（换方言不用改代码）",
    added[0]?.info.package === "@opencode/ai/providers/openai-compatible",
    brief(added[0]?.info),
  );
  check("displayName 选项覆盖 info.name", added[0]?.info.name === "Fake Route", brief(added[0]?.info));
  check(
    "覆盖 package/name 不动别的（模型表逐字不变）",
    same(added[0]?.models, ONE_PAYLOAD.models) && added[0]?.info.settings.baseURL === `${GATEWAY}/v1`,
    brief(added[0]),
  );
}

// ── setup：api key ─────────────────────────────────────────────────────────

console.log("");
console.log("setup：api key（环境变量 → auth.json → 没有；拉目录也带鉴权）");

{
  const { impl, inits } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { added } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY, OPENCODE_FACADE_API_KEY: "sk-test-123" },
    fetchOptions: { fetchImpl: impl },
  });
  check(
    "OPENCODE_FACADE_API_KEY → payload 的 settings.apiKey 等于它",
    added[0]?.info.settings.apiKey === "sk-test-123",
    brief(added[0]?.info.settings),
  );
  const headers = (inits[0]?.headers ?? {}) as Record<string, string>;
  check(
    "有密钥时拉目录带 Authorization: Bearer（拉目录也要能过鉴权）",
    headers.authorization === "Bearer sk-test-123",
    JSON.stringify(headers),
  );
}

{
  const { impl, inits } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { added } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: impl },
  });
  check(
    "不给密钥 → settings.apiKey 是 public（网关 public 模式）",
    added[0]?.info.settings.apiKey === "public",
    brief(added[0]?.info.settings),
  );
  const headers = (inits[0]?.headers ?? {}) as Record<string, string>;
  check("不给密钥 → 拉目录不带 authorization（维持原行为）", !("authorization" in headers), JSON.stringify(headers));
}

{
  // 只在 auth.json 里给（env 不给）：密钥是全机一份、由 core 读写，文件这一级也要能用上
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".config", "agentfacade"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "agentfacade", "auth.json"),
    JSON.stringify({ agentfacade: { type: "api_key", key: "sk-from-file" } }),
  );
  const { impl, inits } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { added } = await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    fetchOptions: { fetchImpl: impl },
    pluginOptions: { home },
  });
  check(
    "只在 auth.json 里给（env 不给）→ payload 也用上了",
    added[0]?.info.settings.apiKey === "sk-from-file",
    brief(added[0]?.info.settings),
  );
  const headers = (inits[0]?.headers ?? {}) as Record<string, string>;
  check(
    "auth.json 里的密钥也带进拉目录的 Authorization",
    headers.authorization === "Bearer sk-from-file",
    JSON.stringify(headers),
  );
}

// ── setup：轮询 ───────────────────────────────────────────────────────────

console.log("");
console.log("setup：轮询（间隔取环境变量；清单变了才重新 add）");

{
  // 间隔：OPENCODE_FACADE_REFRESH_MS 优先，FACADE_REFRESH_MS 是共用的兜底
  const { timers, lastMs } = fakeTimers();
  const { impl } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { ctx } = fakeContext();
  await setup(ctx, {
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY, OPENCODE_FACADE_REFRESH_MS: "60000", FACADE_REFRESH_MS: "90000" },
    home: tempHome(),
    fetchOptions: { fetchImpl: impl },
    warn: () => {},
    timers,
  });
  check("间隔取 OPENCODE_FACADE_REFRESH_MS（自己的变量赢过共用的）", lastMs() === 60000, String(lastMs()));
}

{
  const { timers, lastMs } = fakeTimers();
  const { impl } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { ctx } = fakeContext();
  await setup(ctx, {
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY, FACADE_REFRESH_MS: "90000" },
    home: tempHome(),
    fetchOptions: { fetchImpl: impl },
    warn: () => {},
    timers,
  });
  check("没有自己的间隔变量时取 FACADE_REFRESH_MS", lastMs() === 90000, String(lastMs()));
}

{
  // 清单变了：多一条模型 → core 判定变化 → apply 重新 add
  const { timers, fire } = fakeTimers();
  let body: unknown = ONE_LISTED;
  const { impl } = captureFetch(() => jsonResponse(body));
  const { ctx, added, transforms } = fakeContext();
  const warnings: string[] = [];
  await setup(ctx, {
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    home: tempHome(),
    fetchOptions: { fetchImpl: impl },
    warn: (message: string) => warnings.push(message),
    timers,
  });
  check("首次注册一次（add 与 transform 各一次）", added.length === 1 && transforms() === 1, `${added.length}/${transforms()}`);

  body = { object: "list", data: [{ id: "model-01" }, { id: "model-02" }] };
  await fire();
  check("清单变了 → editor.add 第二次被调用", added.length === 2, String(added.length));
  check("第二次 add 的是新的那份（两条模型）", added[1]?.models.length === 2, String(added[1]?.models.length));
  check("变化记一行日志（core 只在变了的时刻记）", warnings.some((w) => w.includes("model catalog changed")), JSON.stringify(warnings));

  // 连续第二次变化：注入的必须是**最新**那份，不是上一轮缓存的那份
  body = { object: "list", data: [{ id: "model-01" }, { id: "model-02" }, { id: "model-03" }] };
  await fire();
  check(
    "连续第二次变化 → 注入最新那份（三条模型）",
    added.length === 3 && added[2]?.models.length === 3,
    JSON.stringify(added.map((entry) => entry.models.length)),
  );
}

{
  // 清单没变：重排不算变化，id 集合没变就不碰 editor
  const { timers, fire } = fakeTimers();
  const { impl } = captureFetch(() => jsonResponse(ONE_LISTED));
  const { ctx, added, transforms } = fakeContext();
  await setup(ctx, {
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    home: tempHome(),
    fetchOptions: { fetchImpl: impl },
    warn: () => {},
    timers,
  });
  await fire();
  await fire();
  check("清单没变 → 只有首次那一次 add", added.length === 1, String(added.length));
  check("清单没变 → transform 也只有首次那一次", transforms() === 1, String(transforms()));
}

{
  // 轮询拉取失败：保留已注册的清单，不额外 add
  const { timers, fire } = fakeTimers();
  let first = true;
  const { impl } = captureFetch(() => {
    if (first) {
      first = false;
      return jsonResponse(ONE_LISTED);
    }
    throw new Error("connect ECONNREFUSED 127.0.0.1:6450");
  });
  const { ctx, added, transforms } = fakeContext();
  await setup(ctx, {
    env: { OPENCODE_FACADE_GATEWAY: GATEWAY },
    home: tempHome(),
    fetchOptions: { fetchImpl: impl },
    warn: () => {},
    timers,
  });
  check("首次注册一次", added.length === 1, String(added.length));
  await fire();
  check("轮询拉取失败 → 不额外 editor.add（保留上一次的清单）", added.length === 1, String(added.length));
  check("轮询拉取失败 → transform 也没有第二次", transforms() === 1, String(transforms()));
}

// ── 整份清单的快照 ───────────────────────────────────────────────────────

console.log("");
console.log("整份清单 → 整份 payload（与手写快照逐字比对）");

/**
 * 快照用例的输入：6 条 ModelSpec —— **agent 的输入**，不是网关的报文。
 *
 * 之所以不再放一份录制：agent 的职责是「ModelSpec → agent 配置」。网关报文的形状只该有一份
 * （在 core 的测试里）；这一层再抄一份，网关换个渲染就得跟着改，而它一个字段都没变。
 * 这几条的 id / 名字 / 窗口与 fixtures/expected.ts 那份手写快照一一对应。
 */
const SNAPSHOT_SPECS: ModelSpec[] = [
  spec({ id: "coder-a", displayName: "Coder A", efforts: ["off", "low", "high", "max"], contextWindow: 1000000, maxOutputTokens: 384000 }),
  spec({ id: "dsh-manager", displayName: "Deepseek Harness Manager", efforts: ["off", "default", "low", "medium", "high", "xhigh", "max"], contextWindow: 1000000, maxOutputTokens: 128000 }),
  spec({ id: "flat", displayName: "Flat", reasoning: false, efforts: ["off"], contextWindow: 200000, maxOutputTokens: 4096 }),
  spec({ id: "bare", displayName: "bare" }),
  spec({ id: "zeros", displayName: "zeros" }),
  spec({ id: "weird", displayName: "Weird", efforts: ["high", "off", "midium", "high"], contextWindow: 131072, maxOutputTokens: 32768 }),
].map((entry) => ({
  // 快照要的是「网关报过这三项」那一路：能调工具、模态 text+image
  ...entry,
  toolCall: true,
  modalities: { input: ["text", "image"], output: ["text"] },
}));

check("快照的输入面是 6 条 ModelSpec", SNAPSHOT_SPECS.length === 6, String(SNAPSHOT_SPECS.length));

const fromSpecs = toV2Payload(SNAPSHOT_SPECS, { baseUrl: GATEWAY, apiKey: API_KEY });
check("整份 payload 与 fixtures/expected.ts 逐字相同", same(fromSpecs, EXPECTED), brief(fromSpecs));

/**
 * 假网关的回答：这 6 条，**只给 id**（理由同 ONE_LISTED）。
 * 注册路径上的用例只需要「拉到了 6 条」，条目细节由上面的映射用例钉。
 */
const SNAPSHOT_LISTED = { data: SNAPSHOT_SPECS.map(({ id }) => ({ id })) };
check(
  "快照里有 6 条模型（上一行不是两个空对象在比）",
  EXPECTED.models.length === 6,
  String(EXPECTED.models.length),
);
check(
  "快照的 baseURL 是网关根 + /v1",
  EXPECTED.info.settings.baseURL === `${GATEWAY}/v1`,
  EXPECTED.info.settings.baseURL,
);

// ── refresh 的状态语义：空清单绝不替换上一次清单 ─────────────────────────

console.log("");
console.log("refresh（状态语义：空清单不替换上一次的清单）");

{
  let body: unknown = SNAPSHOT_LISTED;
  const { impl } = captureFetch(() => jsonResponse(body));
  const deps = { env: { OPENCODE_FACADE_GATEWAY: GATEWAY }, home: tempHome(), fetchOptions: { fetchImpl: impl } };
  const state = freshState();
  const goodModels = (): number => state.lastGood.at(-1)?.models.length ?? 0;

  const first = await refresh(state, deps);
  check("成功时把这次要注册的 payload 一起交回来", first.ok && first.payload.models.length === 6, brief(first));
  check("成功后清掉 lastError", state.lastError === null, String(state.lastError));
  check("成功后记下时间戳", state.lastRefresh !== null, String(state.lastRefresh));
  check("lastGood 里是那一条 provider（6 条模型）", state.lastGood.length === 1 && goodModels() === 6, String(goodModels()));
  check("core 不碰 registered：刷新不把它设成 true", state.registered === false, String(state.registered));

  body = { data: [] };
  const empty = await refresh(state, deps);
  check("空清单那次算失败（不是成功）", !empty.ok && !empty.cancelled, brief(empty));
  check("空清单不替换上一次的清单（还是那 6 条）", goodModels() === 6, String(goodModels()));
  check("空清单那次留下 lastError", (state.lastError ?? "").includes("listed no models"), String(state.lastError));

  body = SNAPSHOT_LISTED;
  await refresh(state, deps);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await refresh(
    state,
    { env: { OPENCODE_FACADE_GATEWAY: GATEWAY }, home: tempHome(), fetchOptions: { fetchImpl: hangFetch } },
    controller.signal,
  );
  check("被取消的刷新报 cancelled 而不是失败", !cancelled.ok && cancelled.cancelled === true, brief(cancelled));
  check("取消不动 lastError", state.lastError === null, String(state.lastError));
  check("取消不动 lastGood", goodModels() === 6, String(goodModels()));
}

// ── 网关地址 ─────────────────────────────────────────────────────────────

console.log("");
console.log("resolveGateway（候选顺序是 opencode 的事实）");

const home = tempHome();
fs.mkdirSync(path.join(home, ".config", "agentfacade"), { recursive: true });
fs.writeFileSync(path.join(home, ".config", "agentfacade", "config.json"), '{"gateway":"http://new-config.example:6450"}');
fs.mkdirSync(path.join(home, ".config", "buddy-helper"), { recursive: true });
fs.writeFileSync(path.join(home, ".config", "buddy-helper", "config.json"), '{"gateway":"http://from-config.example:6450/"}');

{
  const both = resolveGateway(
    { OPENCODE_FACADE_GATEWAY: "http://opencode.example:6450", FACADE_GATEWAY: "http://facade.example:6450" },
    home,
  );
  check(
    "OPENCODE_FACADE_GATEWAY 赢过其它所有级（值与 from 都能和别的级区分）",
    both.ok && both.gateway === "http://opencode.example:6450" && both.from === "OPENCODE_FACADE_GATEWAY",
    JSON.stringify(both),
  );
}

{
  const facade = resolveGateway({ FACADE_GATEWAY: "http://facade.example:6450" }, home);
  check(
    "没有 agent 自己的变量时 FACADE_GATEWAY 赢过两级配置文件",
    facade.ok && facade.gateway === "http://facade.example:6450" && facade.from === "FACADE_GATEWAY",
    JSON.stringify(facade),
  );
}

{
  const fromFile = resolveGateway({}, home);
  check(
    "环境变量都空 → 读 ~/.config/agentfacade/config.json（三个 agent 共用那份）",
    fromFile.ok && fromFile.gateway === "http://new-config.example:6450" && fromFile.from === "config file",
    JSON.stringify(fromFile),
  );
}

{
  const legacyHome = tempHome();
  fs.mkdirSync(path.join(legacyHome, ".config", "buddy-helper"), { recursive: true });
  fs.writeFileSync(path.join(legacyHome, ".config", "buddy-helper", "config.json"), '{"gateway":"http://from-config.example:6450/"}');
  const fromLegacy = resolveGateway({}, legacyHome);
  check(
    "只有旧路径 → 读 buddy-helper，from 是 legacy config file，末尾斜杠去掉",
    fromLegacy.ok && fromLegacy.gateway === "http://from-config.example:6450" && fromLegacy.from === "legacy config file",
    JSON.stringify(fromLegacy),
  );
}

{
  const nowhere = resolveGateway({}, tempHome());
  check(
    "哪里都没配 → 退到默认网关，插件开箱能用",
    nowhere.ok && nowhere.gateway === DEFAULT_GATEWAY && nowhere.from === "default",
    JSON.stringify(nowhere),
  );

  // 自己的那份严格：坏文件报错；旧文件宽容：坏文件当没配 —— 两条分开钉
  const brokenOwn = tempHome();
  fs.mkdirSync(path.join(brokenOwn, ".config", "agentfacade"), { recursive: true });
  fs.writeFileSync(path.join(brokenOwn, ".config", "agentfacade", "config.json"), "{ not json");
  const own = resolveGateway({}, brokenOwn);
  check(
    "自己的配置文件 JSON 坏 → 报错带文件路径与原因，不悄悄退默认",
    !own.ok && own.error.includes("agentfacade/config.json") && own.error.includes("not valid JSON"),
    JSON.stringify(own),
  );

  const broken = tempHome();
  fs.mkdirSync(path.join(broken, ".config", "buddy-helper"), { recursive: true });
  fs.writeFileSync(path.join(broken, ".config", "buddy-helper", "config.json"), "{ not json");
  check(
    "旧配置文件坏了 → 当成没配，退到默认网关（历史行为，与新文件不同）",
    resolveGateway({}, broken).ok,
    JSON.stringify(resolveGateway({}, broken)),
  );
}

{
  const badScheme = resolveGateway({ OPENCODE_FACADE_GATEWAY: "ftp://nope" }, tempHome());
  check(
    "不是 http(s) 地址 → 报错而不是拿去请求",
    !badScheme.ok && badScheme.error.includes("http(s)"),
    JSON.stringify(badScheme),
  );
}

check(
  "环境变量优先级就是这两级（顺序是这一侧的事实）",
  same([...GATEWAY_ENV_VARS], ["OPENCODE_FACADE_GATEWAY", "FACADE_GATEWAY"]),
  JSON.stringify([...GATEWAY_ENV_VARS]),
);
check("超时预算是 1500ms（启动路径上被 await 的那个数）", DEFAULT_TIMEOUT_MS === 1500, String(DEFAULT_TIMEOUT_MS));

{
  // 配置文件里那一级真的会变成请求地址（不是只有 resolveGateway 认得）。
  // home 里两级文件都在：共用的 agentfacade 那份赢过旧路径 —— 优先级顺着请求走了一遍
  const { impl, calls } = captureFetch(() => jsonResponse(ONE_LISTED));
  await runSetup({ fetchOptions: { fetchImpl: impl }, pluginOptions: { home } });
  check("配置文件里的地址被真的拿去请求（共用那份赢过旧路径）", same(calls.map(listTarget), ["http://new-config.example:6450/v1/models"]), JSON.stringify(calls));
}

{
  // agent 自己的变量没设、共用变量设了：请求打到共用那个
  const { impl, calls } = captureFetch(() => jsonResponse(ONE_LISTED));
  await runSetup({
    env: { OPENCODE_FACADE_GATEWAY: "", FACADE_GATEWAY: "http://facade.example:6450" },
    fetchOptions: { fetchImpl: impl },
  });
  check("空的 agent 变量被跳过，落到 FACADE_GATEWAY", same(calls.map(listTarget), ["http://facade.example:6450/v1/models"]), JSON.stringify(calls));
}

// ── 插件导出形状 + 归属规则 ───────────────────────────────────────────────

console.log("");
console.log("导出形状与归属规则（源码扫描）");

check("插件 id 是 agentfacade.models", PLUGIN_ID === "agentfacade.models", PLUGIN_ID);
check(
  "默认导出是 v2 的 { id, setup }（不是 v1 那种返回 hooks 的函数）",
  plugin.id === PLUGIN_ID && plugin.setup === setup,
  brief({ id: plugin.id, setup: typeof plugin.setup }),
);
check("默认导出没有 v1 遗留的 server 一格", !("server" in plugin), brief(Object.keys(plugin)));

{
  const SOURCES = ["catalog.ts", "v2.ts", "gateway-config.ts", "index.ts"];
  const files = SOURCES.map((name) => path.join(HOST_DIR, name));
  check("四个源文件都在", files.every((file) => fs.existsSync(file)), JSON.stringify(SOURCES));

  // 网关协议与 core 的归一化词汇不属于 agent 层：这一层只接收 ModelSpec[]
  const PROTOCOL = ["/v1/models", "context_window", "max_output_tokens", "display_name", "effort_options", "fetch("];
  const protocolHits: string[] = [];
  // 写文件的 API 一个都不许有：注册必须是运行时的，用户的配置只能由用户自己改
  const WRITES = ["writeFile", "appendFile", "createWriteStream", "mkdirSync", "unlink", "renameSync", "copyFile", "truncate"];
  const writeHits: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const word of PROTOCOL) if (text.includes(word)) protocolHits.push(`${path.basename(file)}: ${word}`);
    for (const word of WRITES) if (text.includes(word)) writeHits.push(`${path.basename(file)}: ${word}`);
  }
  check("agent 源码里没有网关协议/core 归一化的词汇", protocolHits.length === 0, JSON.stringify(protocolHits));
  check("agent 源码里没有任何写文件的 API", writeHits.length === 0, JSON.stringify(writeHits));
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 条）` : `${fail} 条失败，${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
