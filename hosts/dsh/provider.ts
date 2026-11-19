// dsh 这一侧的 provider profile：ModelSpec[] → llm-pi-ai 条目的 Config。
// 档位在这里必须收敛进封闭词汇（`reasoningEfforts` 不是字符串数组，塞错就整个宿主不可用）；
// 其余地方薄，因为归一化与缺省值在 core。细节见 docs/design.md「宿主：DeepSeek Harness」。

import type { ModelSpec } from "../../core/types.ts";

/** llm-pi-ai 认得的上游协议：`supportedProtocols` 校验用它，也用它挡掉写错的方言 */
export const SUPPORTED_APIS = ["openai-completions", "anthropic-messages"] as const;
export type DshApi = (typeof SUPPORTED_APIS)[number];

/**
 * 默认方言是 openai-completions，**不是** pi 那边的 anthropic-messages：anthropic 路径的 thinking
 * 块 `signature` 是空串（多轮回放有风险），openai 路径推理走 `reasoning_content`。见 docs/design.md。
 */
export const DEFAULT_API: DshApi = "openai-completions";

/** provider 的展示名。用户可能已有自己的路由名，配置可覆盖 */
export const DEFAULT_DISPLAY_NAME = "AgentFacade (main route)";

/** 只写环境变量**名**，密钥本身绝不进配置；网关 public 模式不校验 key，但名字仍然要有 */
export const DEFAULT_API_KEY_ENV = "AGENTFACADE_API_KEY";


/** llm-pi-ai 的封闭档位词汇：reasoningEfforts 的 dict 只认这些键（schemastery 拒未知键） */
export const DSH_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type DshEffort = (typeof DSH_EFFORTS)[number];

/** 模型级 reasoningEfforts 的 dict 一半：档位 → 协议里发送的拼写；off 的 null 表示什么也不发 */
export type ReasoningEffortsProfile = Partial<Record<DshEffort, string | null>>;

/**
 * 网关档位 → `reasoningEfforts` 的 dict：只留认识的七个（未知拼写丢掉），键顺序照网关给的，off 的值是 null。
 * 交集为空返回 undefined，调用方据此整个字段省略（不是 []、也不是 {}）。
 */
export function toReasoningEfforts(efforts: readonly string[]): ReasoningEffortsProfile | undefined {
  const known = new Set<string>(DSH_EFFORTS);
  const out: ReasoningEffortsProfile = {};
  let any = false;
  for (const effort of efforts) {
    if (!known.has(effort)) continue;
    // 网关重复声明同一档：dict 天然只留第一次，这里显式跳过，避免覆盖先前顺序
    if (Object.prototype.hasOwnProperty.call(out, effort)) continue;
    any = true;
    out[effort as DshEffort] = effort === "off" ? null : effort;
  }
  return any ? out : undefined;
}
/** llm-pi-ai 的一条模型定义 */
export interface PiAiModelProfile {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** 省略 = 沿用已安装目录的能力；写成数组会被 schemastery 拒，宿主就整个不可用 */
  reasoningEfforts?: ReasoningEffortsProfile;
}

/** llm-pi-ai 的 provider profile（llm-pi-ai 条目 config.providers.<route> 的形状） */
export interface PiAiProviderProfile {
  displayName: string;
  api: string;
  baseURL: string;
  apiKeyEnv: string;
  models: PiAiModelProfile[];
}

export interface ProviderOptions {
  /** 网关根地址，**不带 /v1**（拼不拼 /v1 由方言决定，见 endpointFor） */
  baseUrl: string;
  /** 上游协议；测试里换 anthropic-messages 用 */
  api: DshApi | string;
  apiKeyEnv: string;
  displayName?: string;
}

/** 口径跟方言变：openai-completions 带 `/v1`，anthropic-messages 到路由根（适配器自己拼 /v1/messages） */
export function endpointFor(baseUrl: string, api: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  return api === "openai-completions" ? `${root}/v1` : root;
}

/** 一条 ModelSpec → llm-pi-ai 的一条模型。归一化在 core，这里换字段名 + 收敛档位 */
export function toModelProfile(spec: ModelSpec): PiAiModelProfile {
  const reasoningEfforts = toReasoningEfforts(spec.efforts);
  return {
    id: spec.id,
    name: spec.displayName,
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxOutputTokens,
    // 交集为空时整个字段省略 —— 省略 =「沿用已安装目录的能力声明」；
    // 写 [] 或 {} 会被 schemastery 当成坏 dict 拒掉
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  };
}

/** ModelSpec[] → provider profile。空清单不该走到这里（core 把空清单判成失败） */
export function toProviderProfile(specs: readonly ModelSpec[], options: ProviderOptions): PiAiProviderProfile {
  return {
    displayName: options.displayName ?? DEFAULT_DISPLAY_NAME,
    api: options.api,
    baseURL: endpointFor(options.baseUrl, options.api),
    apiKeyEnv: options.apiKeyEnv,
    models: specs.map(toModelProfile),
  };
}

/**
 * 旧版宿主的 `ctx.settings` 没有 `isVolatilePath`，没人替我们拦坏配置 —— 写进去就是启动时 llm-pi-ai
 * 报校验错，还会把 providers 里别的路由一起带崩。所以这条路径上由本插件自己按 Config 约定校验。
 * 返回 null 表示形状成立；否则返回一句人话，写进警告。
 */
export function validateProviderProfile(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "provider profile must be an object";
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.displayName !== "string" || rec.displayName === "") {
    return "provider profile is missing a non-empty displayName";
  }
  if (typeof rec.api !== "string" || !(SUPPORTED_APIS as readonly string[]).includes(rec.api)) {
    return `provider profile api ${JSON.stringify(rec.api)} is not one of ${SUPPORTED_APIS.join(", ")}`;
  }
  if (typeof rec.baseURL !== "string" || !/^https?:\/\//.test(rec.baseURL)) {
    return `provider profile baseURL ${JSON.stringify(rec.baseURL)} is not an http(s) URL`;
  }
  if (typeof rec.apiKeyEnv !== "string" || rec.apiKeyEnv === "") {
    return "provider profile is missing apiKeyEnv (secrets never go into config, but the env var name must exist)";
  }
  if (!Array.isArray(rec.models) || rec.models.length === 0) {
    // 这条与 core 的「空清单算失败」同向：空 models 写进去等于把用户手上的模型清空
    return "provider profile models must be a non-empty array — an empty list is never written";
  }
  for (const entry of rec.models) {
    if (typeof entry !== "object" || entry === null) return "provider profile models[] contains a non-object entry";
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== "string" || model.id === "") return "provider profile models[] entry is missing a non-empty id";
    if (typeof model.name !== "string") return `provider profile model "${model.id}" is missing name`;
    if (!isPositiveInt(model.contextWindow)) return `provider profile model "${model.id}" contextWindow must be a positive integer`;
    if (!isPositiveInt(model.maxTokens)) return `provider profile model "${model.id}" maxTokens must be a positive integer`;
    // 契约：省略合法（沿用已安装目录能力）、false 合法（明确不支持）、其余必须是封闭词汇 dict
    if (model.reasoningEfforts !== undefined) {
      const effortsShape = validateReasoningEfforts(model.reasoningEfforts);
      if (effortsShape !== null) return `provider profile model "${model.id}" ${effortsShape}`;
    }
  }
  return null;
}

/**
 * 合法只有三种：省略（调用方跳过）、`false`、以及键全在 DSH_EFFORTS 内且 off 值为 null 的 dict。
 * `false` 本插件不产出，但它是契约里合法的一半，校验要认。
 */
export function validateReasoningEfforts(value: unknown): string | null {
  if (value === false) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `reasoningEfforts must be false or a dict of effort → spelling (got ${JSON.stringify(value)})`;
  }
  for (const [key, spelling] of Object.entries(value as Record<string, unknown>)) {
    if (!(DSH_EFFORTS as readonly string[]).includes(key)) {
      return `reasoningEfforts key ${JSON.stringify(key)} is not one of ${DSH_EFFORTS.join(", ")}`;
    }
    if (key === "off") {
      if (spelling !== null) return `reasoningEfforts.off must be null (means "send nothing", got ${JSON.stringify(spelling)})`;
      continue;
    }
    if (typeof spelling !== "string" || spelling === "") {
      return `reasoningEfforts.${key} must be a non-empty protocol spelling (got ${JSON.stringify(spelling)})`;
    }
  }
  return null;
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

