// 网关 /v1/models 的 payload → ModelSpec[]。纯函数：不碰网络、不读环境变量、不看宿主。
//
// 这里做的是「归一化」，不是「映射到某个宿主」：字段名是网关的字段名，缺省值是网关的
// 约定。宿主的档位阶梯、宿主的成本字段、宿主的方言全都不在这里。

import type { ModelSpec } from "./types.ts";

/**
 * 网关没说上下文/输出上限时的兜底。
 *
 * 为什么放在 core 而不是各宿主：这是**网关**的约定，不是某个客户端的偏好 —— 所有宿主
 * 拿到同一条模型应当给出同样的窗口。谁自己写一份，同一份清单在两个宿主里的行为就会分叉。
 */
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** 网关的一条 data 项：字段全都可缺（老网关不发 effort_options），所以一律从 unknown 收 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * 档位：**原样**保留顺序与拼写。
 *
 * 不排序、不改名、不去重：网关发过来的顺序和拼写（`midium` 这种确实会出现）都是上游的
 * 真实形状，宿主收敛档位时要对着它做决定。core 一动手，宿主就没有原始形状可依。
 * 不是非空字符串数组就当「没有这一格」。
 */
export function normalizeEfforts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out.length > 0 ? out : null;
}

/** 不是布尔就当「不知道」—— 不能当成 false，不知道就按支持思考处理 */
export function normalizeReasoning(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** 0、缺失、非数字都算「没说」。0 是网关表达「没填」的方式，不是真的零窗口 */
function positiveIntOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n !== 0 ? Math.trunc(n) : fallback;
}

/** 网关的一条模型 → 一条 ModelSpec。没有 id 的项 id 是空串，由 modelsFromPayload 丢掉 */
export function toModelSpec(raw: unknown): ModelSpec {
  const fields = asRecord(raw);
  const id = typeof fields.id === "string" ? fields.id : "";
  const display =
    typeof fields.display_name === "string" && fields.display_name.length > 0 ? fields.display_name : id;
  const reasoning = normalizeReasoning(fields.reasoning);
  return {
    id,
    displayName: display,
    // 支不支持思考按网关说的来；没说就按支持（不知道不等于不支持）
    reasoning: reasoning === null ? true : reasoning,
    efforts: normalizeEfforts(fields.effort_options) ?? [],
    contextWindow: positiveIntOr(fields.context_window, DEFAULT_CONTEXT_WINDOW),
    maxOutputTokens: positiveIntOr(fields.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS),
  };
}

/** /v1/models 的 data → ModelSpec[]。没有 id 的项跳过：没有 id 注册出去就是个坏条目 */
export function modelsFromPayload(rawModels: readonly unknown[]): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const raw of rawModels) {
    const spec = toModelSpec(raw);
    if (spec.id === "") continue;
    out.push(spec);
  }
  return out;
}
