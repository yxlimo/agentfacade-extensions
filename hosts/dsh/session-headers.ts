// dsh 的 provider profile 只收静态 headers，放不下「每会话不同」的 id；
// 能拿到 request.sessionId 的只有请求级钩子，所以会话身份按请求在这里写。
// 父会话 id 与 agent 名在这个上下文里没有（request 只有 provider/model/sessionId/purpose/baseURL），
// 取不到就不写 —— 不编一个出来。

import { buildSessionHeaders } from "../../core/session-headers.ts";

/** dsh 传给请求级钩子的 request：只声明本插件读取的字段 */
export interface DshRequestHeadersRequest {
  readonly sessionId?: unknown;
  /** 本次请求发往的 provider 名（路由名）：用来判断是不是发往我们这条线路 */
  readonly provider?: unknown;
}

/** waterfall 监听器：同步执行、必须返回本次请求自己的 Headers */
export type DshRequestHeadersListener = (
  request: DshRequestHeadersRequest,
  headers: Headers,
  next: () => Headers,
) => Headers;

/** cordis 的 ctx.on：类型包不在依赖里，只声明本插件用到的形状 */
export interface DshEventHost {
  on?: (
    name: string,
    listener: DshRequestHeadersListener,
    options?: { global?: boolean; prepend?: boolean },
  ) => unknown;
}

const EVENT_NAME = "llm-pi-ai/request-headers";

/**
 * 注册请求级会话头；没有 ctx.on 的环境（测试、旧版运行时）安静跳过。
 *
 * providerName 从 index.ts 传进来：只有发往这个 provider 的请求才带会话头。
 */
export function registerSessionHeaders(ctx: DshEventHost, providerName: string): void {
  if (typeof ctx?.on !== "function") return;
  ctx.on(
    EVENT_NAME,
    (request, _headers, next) => {
      // next() 只能走一次：它在瀑布里代表「剩下的监听器」。写在 try 里会让 set 失败时
      // 重跑一遍瀑布，等于下游监听器执行两次。所以先过瀑布，再补自己这一格头。
      const out = next();
      try {
        // 这个上下文里只有 sessionId 这一格（没有父 id、没有 agent 名）：core 解析不到就少那一格
        const extra = buildSessionHeaders(
          { sessionId: request?.sessionId },
          { id: request?.provider, name: providerName },
        );
        for (const [key, value] of Object.entries(extra)) out.set(key, value);
      } catch {
        // 头写不进去就少一个头；抛错会让 dsh 把整次调用判成 REQUEST_HEADERS 失败，
        // 而会话头只是附加信息，不值得让模型请求失败。
      }
      return out;
    },
    { global: true },
  );
}
