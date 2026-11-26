// 会话头的形状与归一化：宿主只交「有没有父会话」和三个待解析的值，头名由宿主给。
//
// 头名不能在这一层写死：某个宿主的命名空间前缀只有那个宿主认识；core 只认「三个位置」。
// 另一个必须分开的事实是「有父会话」与「父 id 解析到了」：前者决定写不写，后者只决定
// 父 id 那一格写不写 —— 父会话文件路径存在但读不到 id 时，子会话自己的 id 仍然要发出去。

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

export interface SessionHeaderNames {
	/** 当前会话自己的 id 放哪个头 */
	readonly session: string;
	/** 父会话 id 放哪个头 */
	readonly parent: string;
	/** 解析到的名字放哪个头 */
	readonly agent: string;
}

export interface SessionIdentity {
	/** 有父会话路径才是子会话；与下面的 parentSessionId 的解析结果分开 */
	readonly hasParent: boolean;
	readonly sessionId?: unknown;
	readonly parentSessionId?: unknown;
	readonly agentName?: unknown;
}

/** 只写解析成功的格子。根会话一个都不写 —— 头的问题不能靠「写个空值」来表示 */
export function buildSessionHeaders(
	names: SessionHeaderNames,
	identity: SessionIdentity,
): Record<string, string> {
	if (!identity.hasParent) return {};
	const headers: Record<string, string> = {};
	const session = normalizeSessionId(identity.sessionId);
	if (session !== null) headers[names.session] = session;
	const parent = normalizeSessionId(identity.parentSessionId);
	if (parent !== null) headers[names.parent] = parent;
	const agent = normalizeAgentName(identity.agentName);
	if (agent !== null) headers[names.agent] = agent;
	return headers;
}
