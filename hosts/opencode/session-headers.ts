// opencode 侧会话头：只有这一层认识 opencode 的 hook 形状与头名字。
//
// opencode 原生就发 x-opencode-session-id 与 x-opencode-parent-session-id，那两个头是运行时的
// 事实，本层一个都不碰、绝不覆盖或删除，只补跨宿主统一的 agent 名头。头名是跨宿主契约，
// 但注册入口（model.request 钩子）是 opencode 的事实，所以这段只住在这里，不进 core。

import type { OpencodeV2Context } from "./index.ts";

import { normalizeAgentName } from "../../core/session-headers.ts";

/** agent 名的头名：跨宿主统一契约，不加 opencode 前缀，免得网关认不出来 */
const AGENT_NAME_HEADER = "x-agent-name";

/**
 * 注册 model.request 钩子：在 event.headers 上写 x-agent-name。
 *
 * 名字解析不到就不写 —— normalizeAgentName 削掉非法字符后为空就是 null，发个空头表示不了
 * 「没解析到」，只会把网关带偏。任何异常都吞掉：会话头是附加信息，头的问题不能变成
 * 模型请求失败。
 */
export async function registerSessionHeaders(ctx: OpencodeV2Context): Promise<void> {
  const session = ctx.session;
  if (session === undefined) return;
  try {
    await session.hook("model.request", (event) => {
      try {
        const name = normalizeAgentName(event.agent);
        if (name === null) return;
        event.headers[AGENT_NAME_HEADER] = name;
      } catch {
        // 请求分发时的写入失败同样不能外抛：头是附加信息，模型请求本身要照发
      }
    });
  } catch {
    // 钩子注册失败只是「这个头没有」，不影响 provider 注册，安静跳过
  }
}
