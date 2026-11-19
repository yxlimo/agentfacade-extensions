// 网关 /v1/models 的 payload → ModelSpec[]。纯函数：不碰网络、不读环境变量、不看宿主。
// 这里做归一化而不是映射到某个宿主：字段名与缺省值都是网关的约定。

import type { ModelSpec } from "./types.ts";

/** 网关没报上限时的兜底：这是网关的约定，所有宿主拿到同一条模型该给出同样的窗口 */
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** 原样保留顺序与拼写（网关真会发 `midium`）：不排序、不改名、不去重。不是非空字符串数组就当没有 */
export function normalizeEfforts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out.length > 0 ? out : null;
}

/** 不是布尔就当「不知道」，不能当成 false —— 缺省按支持思考处理 */
export function normalizeReasoning(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** 0、缺失、非数字都算「没说」：0 是网关表达「没填」的方式，不是真的零窗口 */
function positiveIntOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n !== 0 ? Math.trunc(n) : fallback;
}

/** 与 normalizeReasoning 同形不同义，故意分开：一个缺省开、一个缺省不知道 */
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** 0 是有效报价（免费就是 0 元），不能被当成「没说」 */
function priceOrNull(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 两侧都是字符串数组才认：缺一侧是 null 而不是 `[]`，替它填等于宣布一个不存在的限制 */
export function normalizeModalities(value: unknown): ModelSpec["modalities"] {
  const fields = asRecord(value);
  const { input, output } = fields;
  if (!isStringArray(input) || !isStringArray(output)) return null;
  return { input: [...input], output: [...output] };
}

/** 每百万 token、美元；三个键各自独立判存在 —— 缺键是「没报价」，补 0 会变成「免费」 */
export function normalizeCost(value: unknown): ModelSpec["cost"] {
  const text = asRecord(asRecord(value).text);
  const input = asRecord(text.input);
  const cost: NonNullable<ModelSpec["cost"]> = {};
  const inputPrice = priceOrNull(input.price);
  if (inputPrice !== undefined) cost.inputPerMillion = inputPrice;
  const cacheRead = priceOrNull(asRecord(input.cache).read);
  if (cacheRead !== undefined) cost.cacheReadPerMillion = cacheRead;
  const outputPrice = priceOrNull(asRecord(text.output).price);
  if (outputPrice !== undefined) cost.outputPerMillion = outputPrice;
  // 一个键都没有 = 网关没报价。空对象会被宿主当成「有报价，只是都没说」
  return Object.keys(cost).length > 0 ? cost : null;
}

/** 网关的一条模型 → 一条 ModelSpec：没有 id 的项给空串，由 modelsFromPayload 丢掉 */
export function toModelSpec(raw: unknown): ModelSpec {
  const fields = asRecord(raw);
  // 能力、上限、模态各分一层，每一层整格都可能不在
  const capabilities = asRecord(fields.capabilities);
  const limit = asRecord(fields.limit);
  const reasoning = asRecord(capabilities.reasoning);
  const id = typeof fields.id === "string" ? fields.id : "";
  const name = fields.name;
  return {
    id,
    // 网关没给名字就用 id：标题是空串比重复 id 更难认
    displayName: typeof name === "string" && name.length > 0 ? name : id,
    // 没说就按支持：不知道不等于不支持
    reasoning: normalizeReasoning(reasoning.supported) ?? true,
    efforts: normalizeEfforts(reasoning.effort) ?? [],
    contextWindow: positiveIntOr(limit.context, DEFAULT_CONTEXT_WINDOW),
    maxOutputTokens: positiveIntOr(limit.output, DEFAULT_MAX_OUTPUT_TOKENS),
    // 没声明就是「不知道」：替网关判 true 或 false 都是下结论，交给宿主决定
    toolCall: booleanOrNull(asRecord(capabilities.tools).supported),
    modalities: normalizeModalities(fields.modalities),
    cost: normalizeCost(fields.cost),
  };
}

/** 没有 id 的项跳过：没有 id 注册出去就是个坏条目 */
export function modelsFromPayload(rawModels: readonly unknown[]): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const raw of rawModels) {
    const spec = toModelSpec(raw);
    if (spec.id === "") continue;
    out.push(spec);
  }
  return out;
}
