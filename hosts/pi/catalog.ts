// ModelSpec[] → pi 的 provider 配置：档位折进 pi 的阶梯，每条模型带上只有 pi 认的 cost / compat。
// 输入是 core 归一过的 ModelSpec，不是网关报文；映射改这里就要同步改手写期望值（两边一起动是刻意的）。
// 有几处看着像 bug，但**不许顺手改**，理由见 docs/design.md「宿主：pi」。

import type { ModelSpec } from "../../core/types.ts";
/** 从浅到深；顺序即强弱，字母序会把 high 排到 low 前面 */
export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiLevel = (typeof PI_LEVELS)[number];

/** 上游「四档齐全」的那一组。判定齐全那一支走固定映射 */
const FULL_EFFORTS = ["low", "medium", "high", "max"];

/** 每条模型都要带：pi 不替扩展注册的 provider 补 compat，扩展注册路径也不读 provider 级那份 */
const COMPAT = { forceAdaptiveThinking: true, sendSessionAffinityHeaders: true };

/**
 * 网关价 → pi 四格。没报价退回全 0（pi 没有「未知价格」这个状态），写缓存价恒为 0，四格必须齐。
 * 为什么这么折见 docs/design.md「宿主：pi」。
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

export interface PiModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: Record<PiLevel, string | null>;
  /** 每条模型都得自带 cost 与 compat：扩展注册路径不下发 provider 级那份 —— docs/design.md「宿主：pi」 */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat: { forceAdaptiveThinking: boolean; sendSessionAffinityHeaders: boolean };
}

/** pi 的 provider 配置（legacy 形式；refreshModels 由 index.ts 加） */
export interface PiProviderConfig {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  /** 扩展注册路径不读它，只有 models.json 那一路需要 */
  compat?: { forceAdaptiveThinking: boolean; sendSessionAffinityHeaders: boolean };
  models: PiModelEntry[];
}

/** 按强弱排；未知档位（default / none / midium 这种）排在已知的后面 */
export function sortEfforts(efforts: readonly string[]): string[] {
  const rank = new Map<string, number>(PI_LEVELS.map((level, i) => [level, i]));
  return [...efforts].sort((a, b) => {
    const ra = rank.get(a) ?? PI_LEVELS.length;
    const rb = rank.get(b) ?? PI_LEVELS.length;
    return ra === rb ? (a < b ? -1 : a > b ? 1 : 0) : ra - rb;
  });
}

/**
 * pi 档位 → 上游真有的档位。**往下取，不往上取**：往上取等于把「没写档位」变成「思考拉满」。
 * off 那格必须是 "off" 而不是 null：pi 靠 `map.off !== null` 才允许 thinkingEnabled: false。
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
 * 给了档位就照它给的来（档位比 reasoning 更具体）；没档位而 reasoning === false 时兜底 ["off"]，宁可多给一档。
 */
export function effectiveEfforts(efforts: readonly string[] | null, reasoning: boolean | null): string[] {
  if (efforts && efforts.length > 0) return [...efforts];
  if (reasoning === false) return ["off"];
  return [];
}

/** thinkingLevelMap 在这里生成，不在 core：阶梯与「往下取」都是 pi 的策略 */
export function toPiModelEntry(spec: ModelSpec): PiModelEntry {
  return {
    id: spec.id,
    name: spec.displayName,
    reasoning: spec.reasoning,
    input: ["text", "image"],
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxOutputTokens,
    thinkingLevelMap: levelMap(effectiveEfforts(spec.efforts, spec.reasoning)),
    cost: costFor(spec.cost),
    compat: { ...COMPAT },
  };
}


/** baseUrl 是**根地址**（不带 /v1）：pi 走 Anthropic 方言，自己拼 /v1/messages */
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
