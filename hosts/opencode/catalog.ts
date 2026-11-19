// opencode 这一侧与插件 API 版本无关的事实：provider 键与显示名、凭据、baseURL 怎么拼。
// 映射本身在 v2.ts（依赖 v2 的 `Model.Info` 形状）；归一化与缺省值在 core，档位原样透传 ——
// opencode 没有 pi 那套「往下取」的阶梯。

/** 独立名字：与用户已有的 provider 撞名就等于接管了用户自己写的那份配置 */
export const PROVIDER_ID = "agentfacade";

/** 给人看的名字，与 pi 那一侧一致 */
export const PROVIDER_NAME = "AgentFacade (main route)";

/** 网关跑 public 模式时不校验 key */
export const API_KEY = "public";

/**
 * 要带 `/v1`：AI SDK 的 anthropic provider 把 baseURL 当成「已经带版本前缀的根」，自己拼 `/messages`。
 * 不能靠调用方守约 —— 多一个斜杠就是 `...//v1`，AI SDK 不替我们归一。
 */
export function providerBaseUrl(gateway: string): string {
  return `${gateway.trim().replace(/\/+$/, "")}/v1`;
}
