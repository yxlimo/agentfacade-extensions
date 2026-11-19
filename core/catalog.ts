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

/** 网关的一条 data 项：三层（capabilities / limit / modalities）都可能整格不在，所以一律从 unknown 收 */
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

/** 每一格都是布尔或「没说」。与 normalizeReasoning 同形不同义，故意分开：一个缺省开、一个缺省不知道 */
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** 有限数字才算报了价。0 是有效报价（免费就是 0 元），不能被当成「没说」 */
function priceOrNull(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 模态：**两侧都是字符串数组**才认。
 *
 * 只有一侧时不拿 `[]` 顶替另一侧：`input: []` 是「一个模态都不收」，那是网关的断言，
 * 替它填等于我们自己宣布一个不存在的限制；整格不给（null）才是「没人说」。
 */
export function normalizeModalities(value: unknown): ModelSpec["modalities"] {
  const fields = asRecord(value);
  const { input, output } = fields;
  if (!isStringArray(input) || !isStringArray(output)) return null;
  return { input: [...input], output: [...output] };
}

/**
 * 报价：**每百万 token、美元**（网关就是这么报的，core 不缩放、不换算币种）。
 *
 * 三个键各自独立判存在：只报输出价时输入那侧不出现 —— 缺键是「没报价」，0 是「报价为零」，
 * 补 0 会把「没说」变成「免费」，宿主再也分不出来（免费模型与未知价模型在用户那里是两件事）。
 */
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

/** 网关的一条模型 → 一条 ModelSpec。没有 id 的项 id 是空串，由 modelsFromPayload 丢掉 */
export function toModelSpec(raw: unknown): ModelSpec {
  const fields = asRecord(raw);
  // 网关的 openai 渲染把能力、上限、模态各分一层，每一层整格都可能不在
  const capabilities = asRecord(fields.capabilities);
  const limit = asRecord(fields.limit);
  const reasoning = asRecord(capabilities.reasoning);
  const id = typeof fields.id === "string" ? fields.id : "";
  const name = fields.name;
  return {
    id,
    // 网关没给名字就用 id：列表里标题是空串比重复 id 更难认
    displayName: typeof name === "string" && name.length > 0 ? name : id,
    // 支不支持思考按网关说的来；没说就按支持（不知道不等于不支持）
    reasoning: normalizeReasoning(reasoning.supported) ?? true,
    efforts: normalizeEfforts(reasoning.effort) ?? [],
    contextWindow: positiveIntOr(limit.context, DEFAULT_CONTEXT_WINDOW),
    maxOutputTokens: positiveIntOr(limit.output, DEFAULT_MAX_OUTPUT_TOKENS),
    // 工具调用没声明就是 null「不知道」：按 true 会注册出去一个调不了工具的模型，
    // 按 false 会把能调工具的模型标成不支持 —— 两种都是替网关下结论，交给宿主决定
    toolCall: booleanOrNull(asRecord(capabilities.tools).supported),
    modalities: normalizeModalities(fields.modalities),
    cost: normalizeCost(fields.cost),
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
