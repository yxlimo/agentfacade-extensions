// ModelSpec[] → pi 的 provider 配置。这一层只剩 pi 特有的映射：
// 档位怎么折进 pi 的阶梯、每条模型要带哪些只有 pi 才认的字段（cost / compat）。
//
// 输入面是 core 归一过的 ModelSpec，**不是网关报文**：字段名、缺省值、null 的语义都是
// core/types.ts 那张契约的事，宿主不认识也不该认识网关的渲染。
//
// 字段归一化与缺省值**不在这里**：那是 core/catalog.ts 的事（网关的约定，所有宿主共享
// 同一份）。谁在这边重写一遍，同一份清单在两个宿主里的行为就会分叉。
//
// 映射规则是这一层自己的约定：期望值写死在测试里（fixtures/expected.ts 那份手写快照），
// 改这里就要同步改期望值 —— 两边一起动是刻意的，避免「改了映射但测试还绿」。
//
// 有几处看着像 bug，但**不许顺手改**：网关报的档位里有 "default" 时 rank 里查不到，
// 排在最后，于是 pi 的 max 会映到 "default"（见 test/check.ts 里手写 SPECS 的 model-02）。
// 那是上游报出来的真实形状，改掉就与网关对不上了。

import type { ModelSpec } from "../../core/types.ts";
/** pi 的思考档位，从浅到深。顺序即强弱，字母序会把 high 排到 low 前面 */
export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiLevel = (typeof PI_LEVELS)[number];

/** 上游「四档齐全」的那一组。判定齐全那一支走固定映射 */
const FULL_EFFORTS = ["low", "medium", "high", "max"];

/**
 * 每条模型都要带的 compat：pi 不会替扩展注册的 provider 补它。
 *
 * 两项都必须下发到模型级 —— 扩展注册路径不读 provider 级的那份。
 */
const COMPAT = { forceAdaptiveThinking: true, sendSessionAffinityHeaders: true };

/**
 * 网关的价格 → pi 的四格 cost。口径就是网关的口径（每百万 token、美元），不缩放、不换算。
 *
 * `spec.cost === null` 是「网关没报价」：退回全 0。**0 表示不计价**，与「没报价」在 pi 侧
 * 不可区分 —— 那是 pi 的成本统计口径（它没有「未知价格」这个状态），不是我们的断言。
 *
 * 写缓存价恒为 0：网关只报输入/输出/读缓存三侧，没有写缓存价这一项。按 0 计（宁可少算，
 * 不虚报）比攥一个数安全。
 *
 * 某一侧没报价 → 那一侧也是 0（用 `??` 而不是真值判断：0 元是**有**报价）。四格必须齐，
 * 缺一格整个 cost 就没意义。
 */
function costFor(cost: ModelSpec["cost"]): PiModelEntry["cost"] {
  if (cost === null) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: cost.inputPerMillion ?? 0,
    output: cost.outputPerMillion ?? 0,
    cacheRead: cost.cacheReadPerMillion ?? 0,
    cacheWrite: 0,
  };
}

/** pi 的一条模型定义 */
export interface PiModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: Record<PiLevel, string | null>;
  /**
   * 每条模型都自带 cost 与 compat，不能只写在 provider 上。
   *
   * pi 对两条注册路做归一化的程度不一样（1.5.2，dist/core/provider-composer.js）：
   *   · models.json：`modelFromJson()` 补 cost 默认值（`definition.cost ?? {…}`），
   *     `applyModelsJson()` 再把 provider 级 compat 并进每条模型（`mergeCompat`）；
   *   · 扩展注册：`extensionModelFromDefinition()` 只是把定义展开，provider 级的
   *     cost / compat 一个都不下发。
   *
   * 缺了会怎样（都在 pi 1.5.2 上实测）：
   *   · 没有 cost → 请求在第一个 SSE 事件上抛
   *     `Cannot read properties of undefined (reading 'tiers')`（calculateCost 读 model.cost.tiers）
   *   · 没有 compat → 不发 `x-session-affinity`（openrouter 格式才发 `x-session-id`），网关拿不到
   *     客户端会话 id，上游答 400 MissingSessionID，网关把它包成 502（见 README 那张表），
   *     而且 forceAdaptiveThinking 一起没了 —— 算出来的 thinkingLevelMap 整条被绕过。
   */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat: { forceAdaptiveThinking: boolean; sendSessionAffinityHeaders: boolean };
}

/** pi 的 provider 配置（legacy 形式；refreshModels 由 index.ts 加） */
export interface PiProviderConfig {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  /** provider 级 compat 可选：扩展注册路径不读它，只有 models.json 那一路需要 */
  compat?: { forceAdaptiveThinking: boolean; sendSessionAffinityHeaders: boolean };
  models: PiModelEntry[];
}

/** 档位按强弱排，未知档位（default / none / midium 这种）排在已知的后面 */
export function sortEfforts(efforts: readonly string[]): string[] {
  const rank = new Map<string, number>(PI_LEVELS.map((level, i) => [level, i]));
  return [...efforts].sort((a, b) => {
    const ra = rank.get(a) ?? PI_LEVELS.length;
    const rb = rank.get(b) ?? PI_LEVELS.length;
    return ra === rb ? (a < b ? -1 : a > b ? 1 : 0) : ra - rb;
  });
}

/**
 * pi 的思考档位 → 上游真有的档位。往下取，不往上取。
 *
 * 往下取的原因：档位是成本与延迟的旋钮，
 * pi 默认 medium，往上取等于把「配置里没写档位」变成「思考拉满」。
 *
 * off 是阶梯最浅的一档，不是布尔开关：
 *   - 只有 off 一档 → 每个 pi 档位都映到 off（没有别的能发）。off 那格必须是
 *     "off" 而不是 null，pi 靠 map.off !== null 才允许 thinkingEnabled: false
 *   - off 与其它档并存 → off 只映 off，其它档照常往下取，且没有思考档被映到 off
 *   - 没有 off → 关不掉思考（off 那格是 null）
 */
export function levelMap(efforts: readonly string[] | null): Record<PiLevel, string | null> {
  const all = () => blankMap(null);
  if (!efforts || efforts.length === 0) return all();
  if (efforts.includes("off")) {
    const rest = efforts.filter((e) => e !== "off");
    if (rest.length === 0) return blankMap("off");
    const mapping = levelMapWithoutOff(rest);
    mapping.off = "off";
    return mapping;
  }
  return levelMapWithoutOff(efforts);
}

function blankMap(value: string | null): Record<PiLevel, string | null> {
  const out = {} as Record<PiLevel, string | null>;
  for (const level of PI_LEVELS) out[level] = value;
  return out;
}

/** off 之外的档位怎么映。四档齐全时是一张定表（顺序与 rank 排序不同，别合并） */
function levelMapWithoutOff(efforts: readonly string[]): Record<PiLevel, string | null> {
  const sortedGiven = [...efforts].sort();
  const sortedFull = [...FULL_EFFORTS].sort();
  if (sortedGiven.length === sortedFull.length && sortedGiven.every((e, i) => e === sortedFull[i])) {
    return {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "max",
    };
  }

  const rank = new Map<string, number>(PI_LEVELS.map((level, i) => [level, i]));
  const ordered = sortEfforts(efforts);
  const lowest = ordered[0];
  const highest = ordered[ordered.length - 1];

  // 不高于 level 的最近一档；上游连更低的一档都没有时只能往上取最低那档
  const atOrBelow = (level: PiLevel): string => {
    const limit = rank.get(level) ?? PI_LEVELS.length;
    const below = ordered.filter((e) => (rank.get(e) ?? PI_LEVELS.length) <= limit);
    return below.length > 0 ? below[below.length - 1] : lowest;
  };

  return {
    off: null,
    minimal: lowest,
    low: lowest,
    medium: atOrBelow("medium"),
    high: atOrBelow("high"),
    xhigh: atOrBelow("xhigh"),
    max: highest,
  };
}

/**
 * 网关给的档位 + 「这个模型支不支持思考」→ 实际可用的档位。
 *
 * 网关说没有思考能力（reasoning === false）却没给档位时兜底成 ["off"]：宁可多给
 * 一档，也不要把「不知道」当成「不支持」。网关给了档位就照它给的来，不看 reasoning
 * —— 档位是更具体的信息。
 */
export function effectiveEfforts(efforts: readonly string[] | null, reasoning: boolean | null): string[] {
  if (efforts && efforts.length > 0) return [...efforts];
  if (reasoning === false) return ["off"];
  return [];
}

/**
 * 一条 ModelSpec → 一条 pi 模型。正常路径（core 已经把 payload 归一化过）走这个。
 *
 * thinkingLevelMap 在这里生成，不在 core：`off`/`minimal`/… 是 pi 的阶梯，
 * 「往下取不往上取」是 pi 的成本策略（见 levelMap）。
 */
export function toPiModelEntry(spec: ModelSpec): PiModelEntry {
  return {
    id: spec.id,
    name: spec.displayName,
    // 支不支持思考按网关说的来；core 已经把「没说」折成 true（不知道不等于不支持）
    reasoning: spec.reasoning,
    input: ["text", "image"],
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxOutputTokens,
    thinkingLevelMap: levelMap(effectiveEfforts(spec.efforts, spec.reasoning)),
    cost: costFor(spec.cost),
    compat: { ...COMPAT },
  };
}


/**
 * provider 配置。baseUrl 是**根地址**（不带 /v1）：pi 走 Anthropic 方言，自己拼
 * /v1/messages。
 */
export function toProviderConfig(gateway: string, apiKey: string, models: readonly PiModelEntry[]): PiProviderConfig {
  return {
    name: "AgentFacade (main route)",
    baseUrl: gateway,
    api: "anthropic-messages",
    apiKey,
    // 不写 provider 级 compat：扩展注册路径不读它，每条模型上那份才生效
    models: [...models],
  };
}
