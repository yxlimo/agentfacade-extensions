// opencode v2 的 provider 注入形状（本机 2.2.7 实测 dump 出来的，见 docs/design.md 的 OpenCode 一节）。
// 与 v1 的差别是这次重写的理由：v2 没有 `capabilities.reasoning`，可选变体挂在 `variants`，而条目形状无文档 ——
// 所以档位在 opencode 上不表达，这里不发明字段。也不 import `@opencode/plugin`：那个包由运行时提供。

import type { AdapterOptions, ModelSpec } from "../../core/types.ts";
import { PROVIDER_ID, PROVIDER_NAME, providerBaseUrl } from "./catalog.ts";

/** 没声明按**支持**（与 pi 的缺省一致）：缺省关掉工具会把模型降级成只会聊天 */
function toolsFor(spec: ModelSpec): boolean {
  return spec.toolCall === null ? true : spec.toolCall;
}

/**
 * 没报模态时退回录制里的常量（`~/.config/opencode/shay-models.jsonc` 的实录制，16 个模型全是这两项）。
 * 退回的是录制里的事实，不是推断：网关报了就以网关为准，连 `input: []` 也照它的来。
 */
const INPUT_MODALITIES = ["text", "image"] as const;
const OUTPUT_MODALITIES = ["text"] as const;

function modalitiesFor(spec: ModelSpec): { input: string[]; output: string[] } {
  if (spec.modalities === null) return { input: [...INPUT_MODALITIES], output: [...OUTPUT_MODALITIES] };
  return { input: [...spec.modalities.input], output: [...spec.modalities.output] };
}

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
  /** 显式开启：`Provider.Info.empty()` 的缺省是 `auto` */
  activation: "enabled";
  /** 协议包：决定走哪套方言 */
  package: string;
  settings: { baseURL: string; apiKey: string };
}

/** 一次 `editor.add()` 的完整入参 */
export interface OpencodeV2Payload {
  info: OpencodeV2ProviderInfo;
  models: OpencodeV2Model[];
}

/** `name` 必须覆盖：`Model.Info.default()` 给的 name 是裸 id，选择器里就全是机器名 */
export function toV2Model(spec: ModelSpec, providerID: string = PROVIDER_ID): OpencodeV2Model {
  return {
    id: spec.id,
    modelID: spec.id,
    providerID,
    name: spec.displayName,
    capabilities: {
      tools: toolsFor(spec),
      ...modalitiesFor(spec),
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
 * 实测结论，不是按名字推断的：`@ai-sdk/anthropic`（v1 写法）在 v2 上直接失败，因为 v2 要求 package 导出
 * `model(modelID, settings)`；`@opencode/ai/providers/anthropic` 可用，真机 `opencode run` 回了 PONG。
 * 另一个候选 `@opencode/ai/providers/openai-compatible` 没有实测。换包就是换方言，换之前先验一次真实请求。
 */
export const DEFAULT_PACKAGE = "@opencode/ai/providers/anthropic";
