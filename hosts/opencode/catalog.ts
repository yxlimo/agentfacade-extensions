// opencode 这一侧**与插件 API 版本无关**的事实：provider 的键与显示名、凭据、baseURL 怎么拼。
//
// 映射本身不在这里，在 v2.ts —— 它依赖 v2 的 `Model.Info` 形状，会随 opencode 版本变。
// 而 provider 键名、apiKey、`/v1` 的拼法在 v1/v2 之间没变过，留在这里，改插件 API 时不必连带改。
//
// 字段归一化与缺省值**不在这里**：那是 core/catalog.ts 的事（网关的约定，所有宿主共享同一份）。
// 档位也不在这里收敛：opencode 原样吃上游给的档位，pi 那套「往下取」的阶梯是本宿主没有的概念。

/**
 * provider 键。独立名字，不与用户已有的 provider（buddy 之类）撞名 —— 撞名就等于接管了
 * 用户自己写的那份配置。
 */
export const PROVIDER_ID = "agentfacade";

/** 给人看的名字，与 pi 那一侧一致 */
export const PROVIDER_NAME = "AgentFacade (main route)";

/** 网关跑 public 模式时不校验 key */
export const API_KEY = "public";

/**
 * AI SDK 的 anthropic provider 把 baseURL 当成「已经带版本前缀的根」，自己拼 `/messages`，
 * 所以这里要带 `/v1`（录制里的真实配置就是 `.../v1`）。
 *
 * core 传进来的 baseUrl 是网关根地址、且 core 已经去过末尾斜杠，但这一层不能靠调用方守约：
 * 多一个斜杠就是 `...//v1`，AI SDK 不会替我们归一，请求会打到 `/v1/messages` 之外去。
 */
export function providerBaseUrl(gateway: string): string {
  return `${gateway.trim().replace(/\/+$/, "")}/v1`;
}
