// opencode 侧会话头：只有这一层认识 opencode 的 hook 形状。
//
// opencode 原生发的 x-opencode-session-id / x-opencode-parent-session-id 是运行时的
// 事实，本层不覆盖、不删除；只把两个 id 镜像到本插件自己的头名，并补会话名字。
// 注册入口（model.request 钩子）是 opencode 的事实，所以这段只住在这里，不进 core。

import type { OpencodeV2Context } from "./index.ts";

import { SESSION_HEADERS, normalizeAgentName, normalizeSessionId } from "../../core/session-headers.ts";

/**
 * 注册 model.request 钩子：三格各自独立，解析到才写，原生 x-opencode-* 一个字节都不动。
 *
 * 名字与 id 解析不到就省略 —— 空头表示不了「没解析到」，只会把网关带偏。任何异常都吞掉：
 * 会话头是附加信息，头的问题不能变成模型请求失败。
 */
export async function registerSessionHeaders(ctx: OpencodeV2Context): Promise<void> {
  const session = ctx.session;
  if (session === undefined) return;
  try {
    await session.hook("model.request", (event) => {
      try {
        const sessionId = normalizeSessionId(event.sessionID);
        if (sessionId !== null) event.headers[SESSION_HEADERS.sessionId] = sessionId;
        const parentSessionId = normalizeSessionId(event.headers["x-opencode-parent-session-id"]);
        if (parentSessionId !== null) event.headers[SESSION_HEADERS.parentSessionId] = parentSessionId;
        const sessionName = normalizeAgentName(event.agent);
        if (sessionName !== null) event.headers[SESSION_HEADERS.sessionName] = sessionName;
      } catch {
        // 请求分发时的写入失败同样不能外抛：头是附加信息，模型请求本身要照发
      }
    });
  } catch {
    // 钩子注册失败只是「这个头没有」，不影响 provider 注册，安静跳过
  }
}
