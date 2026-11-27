// 会话头的形状与归一化：头名是本插件自己的线路契约，宿主只交三个待解析的值。
//
// 三个格子各自独立：解析到就写，解析不到就省略。根会话也能拿到自己的 id 与名字；
// 父 id 缺失只代表「没有父 id 这一格」，不能当成整批不发的理由。

const ID_MAX = 128;
const AGENT_NAME_MAX = 64;
const ID_CONTROL = /[\u0000-\u001f\u007f]/g;
const AGENT_NAME_KEEP = /[^A-Za-z0-9._-]/g;

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** 会话 id：空白与控制字符都不进头；空串当未解析，长度上限按字符数截 */
export function normalizeSessionId(value: unknown): string | null {
	const cleaned = textOf(value).trim().replace(ID_CONTROL, "");
	if (cleaned === "") return null;
	return cleaned.slice(0, ID_MAX);
}

/** 名字只留安全字符。削掉非法字符后为空就是「没解析到」，不能发空头 */
export function normalizeAgentName(value: unknown): string | null {
	const cleaned = textOf(value).replace(AGENT_NAME_KEEP, "");
	if (cleaned === "") return null;
	return cleaned.slice(0, AGENT_NAME_MAX);
}

/** 插件自己发往网关的三个头名；宿主只认识钩子的形状，不重复声明头名 */
export const SESSION_HEADERS = {
	sessionId: "agentfacade-session-id",
	parentSessionId: "agentfacade-parent-session-id",
	sessionName: "agentfacade-session-name",
} as const;

export interface SessionIdentity {
	readonly sessionId?: unknown;
	readonly parentSessionId?: unknown;
	readonly sessionName?: unknown;
}

/** 每格独立判定；解析不到就省略，绝不写空值 —— 空头只会把网关带偏 */
export function buildSessionHeaders(identity: SessionIdentity): Record<string, string> {
	const headers: Record<string, string> = {};
	const sessionId = normalizeSessionId(identity.sessionId);
	if (sessionId !== null) headers[SESSION_HEADERS.sessionId] = sessionId;
	const parentSessionId = normalizeSessionId(identity.parentSessionId);
	if (parentSessionId !== null) headers[SESSION_HEADERS.parentSessionId] = parentSessionId;
	const sessionName = normalizeAgentName(identity.sessionName);
	if (sessionName !== null) headers[SESSION_HEADERS.sessionName] = sessionName;
	return headers;
}
