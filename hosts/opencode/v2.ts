// opencode v2（本机 2.2.7）的 provider 注入形状。
//
// 事实来源：**实测**，不是文档抄写。做法是写一个最小插件跑
// `opencode models --standalone`，把 `Model.Info.default()` / `Provider.Info.empty()`
// 的运行时对象 dump 出来逐字比对。形状如下（v2.2.7）：
//
//   模型：{ id, modelID, providerID, name,
//           capabilities: { tools: true, input: ["text","image"], output: ["text"] },
//           variants: [], time: { released: 0 }, cost: [], status: "active",
//           enabled: true, limit: { context: 200000, output: 32000 } }
//   provider：{ id, name, activation: "auto" | "enabled", package: "" | <包名> }
//
// 与 v1 的差别（这就是这次重写的原因）：v1 的 `capabilities.reasoning.{supported,effort}`
// 在 v2 **不存在**；v2 的可选变体挂在 `variants`（钩子里是 `model.variant`），但条目形状
// 文档没给、实测默认是空数组 —— 所以这里**不发明**，档位信息在 opencode 上暂不表达，
// 见 README 的「已知缺口」。
//
// 为什么不 import `@opencode/plugin`：那个包是 opencode 运行时注入的，本仓没有这个依赖；
// 而且我们要的东西全是纯数据（brand 只在类型层），直接构造对象既少一个依赖也少一层
// 版本耦合 —— 真机验证过 `editor.add()` 认这份对象。

import type { AdapterOptions, ModelSpec } from "../../core/types.ts";
import { PROVIDER_ID, PROVIDER_NAME, providerBaseUrl } from "./catalog.ts";

/** 网关的模型都能开工具；opencode 靠这一格决定要不要把工具定义发下去 */
const TOOLS = true;
/** 模态：录制里 16 个模型全是这两项（`~/.config/opencode/shay-models.jsonc` 的实录制）。按录制的事实填，不是猜。 */
const INPUT_MODALITIES = ["text", "image"] as const;
const OUTPUT_MODALITIES = ["text"] as const;

/** opencode v2 的一条模型定义（`Model.Info` 的运行时形状） */
export interface OpencodeV2Model {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: {
    tools: boolean;
    input: string[];
    output: string[];
  };
  /** 可选变体。形状未知 → 恒为空数组，绝不编造 */
  variants: never[];
  time: { released: number };
  cost: unknown[];
  status: "active";
  enabled: boolean;
  limit: { context: number; output: number };
}

/** opencode v2 的一个 provider 定义（`Provider.Info` + 我们写进去的 settings） */
export interface OpencodeV2ProviderInfo {
  id: string;
  name: string;
  /** `enabled` 表示「可用且默认参与」，对应 `Provider.Info.empty()` 的 `auto` 之外的显式开启 */
  activation: "enabled";
  /** 协议包：决定走哪套方言。v1 用 `@ai-sdk/anthropic`，v2 官方例子里是 `@opencode/ai/providers/*` */
  package: string;
  settings: { baseURL: string; apiKey: string };
}

/** 一次 `editor.add()` 的完整入参 */
export interface OpencodeV2Payload {
  info: OpencodeV2ProviderInfo;
  models: OpencodeV2Model[];
}

/**
 * 一条 ModelSpec → 一条 v2 模型定义。
 *
 * `name` 必须覆盖：`Model.Info.default()` 给的 name 是裸 id，不覆盖的话选择器里全是
 * `coder-a` 这种机器名。
 */
export function toV2Model(spec: ModelSpec, providerID: string = PROVIDER_ID): OpencodeV2Model {
  return {
    id: spec.id,
    modelID: spec.id,
    providerID,
    name: spec.displayName,
    capabilities: {
      tools: TOOLS,
      input: [...INPUT_MODALITIES],
      output: [...OUTPUT_MODALITIES],
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: spec.contextWindow, output: spec.maxOutputTokens },
  };
}

/** 整份清单 → 一次注入。空清单不该走到这里（core 把空清单判成失败）。 */
export function toV2Payload(
  specs: readonly ModelSpec[],
  opts: AdapterOptions & { pkg?: string; displayName?: string },
): OpencodeV2Payload {
  return {
    info: {
      id: PROVIDER_ID,
      name: opts.displayName ?? PROVIDER_NAME,
      activation: "enabled",
      package: opts.pkg ?? DEFAULT_PACKAGE,
      settings: { baseURL: providerBaseUrl(opts.baseUrl), apiKey: opts.apiKey },
    },
    models: specs.map((spec) => toV2Model(spec, PROVIDER_ID)),
  };
}

/**
 * 默认协议包。**实测结论，不是按名字推断的**：
 *
 *   · `@ai-sdk/anthropic`（v1 时代用户配置里的写法）在 v2 上直接失败：
 *     `Provider package @ai-sdk/anthropic does not export model(modelID, settings)` ——
 *     v2 要求 package 是一个导出 `model(modelID, settings)` 的模块，v1 的 AI SDK 包不是。
 *   · `@opencode/ai/providers/anthropic` 可用：真机 `opencode run --model agentfacade/coder-a`
 *     回了 `PONG`（baseURL 带 `/v1`，与网关主路由的 anthropic 方言一致）。
 *
 * 另一个候选 `@opencode/ai/providers/openai-compatible`（v2 官方例子用的那个）没有实测，
 * 留作可配置项；换包就是换方言，换之前先验一次真实请求。
 */
export const DEFAULT_PACKAGE = "@opencode/ai/providers/anthropic";
