// test/check.ts — pi-models-plugin 的自检。
//
//   node --experimental-strip-types test/pi-models-plugin-check.ts
//
// 覆盖四块：
//   · 字段映射：ModelSpec[] → pi 的 provider 配置。输入面是下面手写的 SPECS（17 条），
//     期望值写在 fixtures/expected.ts 里 —— 手写快照，不由任何程序生成。
//     网关报文长什么样不在这层：那是 core 的事，形状只留一份。
//   · 网关地址解析：PI_FACADE_GATEWAY > FACADE_GATEWAY > 配置文件
//   · 真实网络：起一个 127.0.0.1 的假网关（startFakeUpstream），走真的 fetch；
//     可达时注册的模型数等于 /v1/models 的 data 长度，不可达时**不注册**且不抛
//   · 刷新与命令：refreshModels 重新拉、拉不到时交回上一次的清单而不是空数组、
//     /facade-models 显示的几个数字
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
import type { ModelSpec } from "../../../core/types.ts";
import { resolveGateway } from "../gateway-config.ts";
import { EXPECTED as EXPECTED_SNAPSHOT } from "../fixtures/expected.ts";
import { startFakeUpstream } from "./fake-upstream.ts";

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
 * 快照用例的输入：17 条 ModelSpec —— **宿主的输入**，不是网关的报文。
 *
 * 为什么不放一份录制：宿主的职责是「ModelSpec → 宿主配置」。网关报文的形状只该有一份
 * （在 core 的测试里）；宿主测试再抄一份，网关换个渲染这一层就得跟着改，而它一个字段
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
 * 宿主的义务到 ModelSpec 为止；条目里其余字段长什么样是 core 的事（形状只留一份），
 * 这样网关改渲染时这一层不会被拖下水。这些用例需要的只是「有 N 条能过 core 的清单」。
 */
const LISTED = { data: SPECS.map(({ id }) => ({ id })) };

/**
 * 请求打到的是不是模型清单那一路。
 *
 * 只看路径：清单地址上挂什么方言（`?dialect=` 之类）是 core 的事，宿主这一层不该知道。
 * 写死整条 URL 会让 core 换个方言这一层就红 —— 那不是宿主的行为变了。
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
  // 档位阶梯是宿主的事：这里只钉「spec.efforts 真的接到了 levelMap 上」（逐字）
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
console.log("resolveGateway");

const home = tempHome();
fs.mkdirSync(path.join(home, ".config", "buddy-helper"), { recursive: true });
fs.writeFileSync(path.join(home, ".config", "buddy-helper", "config.json"), '{"gateway":"http://from-config.example:6450/"}');

const both = resolveGateway({ PI_FACADE_GATEWAY: "http://pi.example:6450", FACADE_GATEWAY: "http://facade.example:6450" }, home);
check(
  "PI_FACADE_GATEWAY 赢过 FACADE_GATEWAY 与配置文件",
  both.ok && both.gateway === "http://pi.example:6450" && both.from === "PI_FACADE_GATEWAY",
  JSON.stringify(both),
);

const facade = resolveGateway({ FACADE_GATEWAY: "http://facade.example:6450" }, home);
check(
  "没有 PI_FACADE_GATEWAY 时 FACADE_GATEWAY 赢过配置文件",
  facade.ok && facade.gateway === "http://facade.example:6450" && facade.from === "FACADE_GATEWAY",
  JSON.stringify(facade),
);

const fromFile = resolveGateway({}, home);
check(
  "都没有时读 ~/.config/buddy-helper/config.json 的 gateway，并去掉末尾斜杠",
  fromFile.ok && fromFile.gateway === "http://from-config.example:6450" && fromFile.from === "config file",
  JSON.stringify(fromFile),
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

const brokenConfigHome = tempHome();
fs.mkdirSync(path.join(brokenConfigHome, ".config", "buddy-helper"), { recursive: true });
fs.writeFileSync(path.join(brokenConfigHome, ".config", "buddy-helper", "config.json"), "{ not json");
check(
  "配置文件坏了 → 当成没配，退到默认网关",
  resolveGateway({}, brokenConfigHome).ok,
  JSON.stringify(resolveGateway({}, brokenConfigHome)),
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
  command: { name: string; handler: (args: string, ctx: unknown) => Promise<void> } | null;
}

function fakePi(): PiExtensionApi & Captured {
  const captured: PiExtensionApi & Captured = {
    provider: null,
    command: null,
    registerProvider(name, config) {
      captured.provider = { name, config };
    },
    registerCommand(name, options) {
      captured.command = { name, handler: options.handler as (args: string, ctx: unknown) => Promise<void> };
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
  const state = { gateway: "", from: "", models: [], lastRefresh: null, lastError: "boom", registered: false };
  const lines = describe(state).join("\n");
  check("未注册时 describe 说 NOT registered 并给下一步", lines.includes("NOT registered") && lines.includes("/facade-models refresh"), lines);

  const okState = { gateway: "http://gw.example:6450", from: "config file", models: [toPiModelEntry(spec({ id: "a" }))], lastRefresh: Date.now(), lastError: null, registered: true };
  check("已注册时 describe 报模型数与网关", describe(okState).join("\n").includes("1 registered"), describe(okState).join("\n"));
}

// ── refresh() 在成功后会清掉上一次的错误 ────────────────────────────────

{
  const live = await startFakeUpstream(() => ({ body: LISTED }));
  const state = { gateway: "", from: "", models: [] as PiModelEntry[], lastRefresh: null as number | null, lastError: "old failure" as string | null, registered: false };
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

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 条）` : `${fail} 条失败，${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
