// pi 侧会话头：只有这一层认识 pi 的头名和 sessionManager 的形状。
//
// pi 自己发的 x-session-id / x-session-affinity 会被 pi-subagents 改写成父会话 id，用来命中
// 父会话的 prompt cache。所以这里不碰那两个头，只补三个不参与路由的头。
// 父会话 header 里存的是**文件路径**；权威 id 在文件首行的 JSON 里，整文件几十 MB，不能全读。

import fs from "node:fs";
import path from "node:path";

import {
	buildSessionHeaders,
	normalizeAgentName,
} from "../../core/session-headers.ts";

/** 首行足够放下 header JSON；读满仍未换行就当读不到，回退文件名，绝不顺着文件往下吞 */
const FIRST_LINE_LIMIT = 64 * 1024;

export function readFirstLineSync(file: string): string | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buffer = Buffer.allocUnsafe(FIRST_LINE_LIMIT);
		const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (size <= 0) return null;
		const chunk = buffer.subarray(0, size).toString("utf8");
		const end = chunk.search(/[\r\n]/);
		return end < 0 ? chunk : chunk.slice(0, end);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// 关闭失败无关头的内容，不能让它冒出去打断模型请求
			}
		}
	}
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type ReadFirstLine = (file: string) => string | null;

export interface ParentSessionIdResolver {
	/** parentSession 可能是相对路径；解析成绝对路径后按路径缓存（含「没解析到」） */
	resolve(parentPath: unknown, cwd?: unknown): string | null;
}

export function createParentSessionIdResolver(readFirstLine: ReadFirstLine = readFirstLineSync): ParentSessionIdResolver {
	const cache = new Map<string, string | null>();
	return {
		resolve(parentPath, cwd) {
			if (typeof parentPath !== "string" || parentPath.trim() === "") return null;
			const base = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
			const file = path.resolve(base, parentPath);
			if (cache.has(file)) return cache.get(file) ?? null;

			let id: string | null = null;
			const first = readFirstLine(file);
			if (first !== null) {
				try {
					const header: unknown = JSON.parse(first.trim());
					if (header !== null && typeof header === "object") {
						const raw = (header as Record<string, unknown>).id;
						if (typeof raw === "string" && raw.trim() !== "") id = raw;
					}
				} catch {
					// 首行坏 JSON 是常见形状，直接用文件名里的 uuid 兜底
				}
			}
			if (id === null) {
				const match = UUID.exec(path.basename(file));
				if (match !== null) id = match[0];
			}
			cache.set(file, id);
			return id;
		},
	};
}

const ACTIVE_AGENT = /<active_agent\b[^>]*\bname\s*=\s*"([^"]*)"/;
const NAME_ONLY = /^[A-Za-z0-9._-]+$/;

/** before_agent_start 的 systemPrompt 是权威来源；没有标记时返回 null，让调用方走会话名回退 */
export function activeAgentName(systemPrompt: unknown): string | null {
	if (typeof systemPrompt !== "string") return null;
	const match = ACTIVE_AGENT.exec(systemPrompt);
	return match === null ? null : normalizeAgentName(match[1]);
}

/** 会话名只有整个都像名字时才用；「会话 A」这类别拿来截成半个头 */
export function sessionAgentName(sessionName: unknown): string | null {
	if (typeof sessionName !== "string") return null;
	const trimmed = sessionName.trim();
	return NAME_ONLY.test(trimmed) ? normalizeAgentName(trimmed) : null;
}

export interface ProviderHeaderEvent {
	headers?: Record<string, string>;
}
export interface AgentStartEvent {
	systemPrompt?: unknown;
}
export interface SessionHeaderLike {
	parentSession?: string;
	readonly [key: string]: unknown;
}
export interface SessionManagerLike {
	getHeader?(): SessionHeaderLike | undefined;
	getSessionId?(): string | undefined;
	getSessionFile?(): string | undefined;
	getSessionName?(): string | undefined;
	getCwd?(): string | undefined;
}
export interface HookContextLike {
	sessionManager?: SessionManagerLike;
	/**
	 * pi 交给钩子的是裸 ExtensionContext：只有 model 这个属性，没有 getModel()。
	 * model.provider 是本次请求要发的 provider 名（不是模型 id）。
	 */
	model?: { provider?: unknown };
}
export interface SessionHookApi {
	on(name: "before_agent_start", handler: (event: AgentStartEvent, ctx: HookContextLike) => void): void;
	on(name: "before_provider_headers", handler: (event: ProviderHeaderEvent, ctx: HookContextLike) => void): void;
}

/** 注册会话头钩子需要的两样东西：provider 名从 index.ts 传进来，避免两个文件互相 import */
export interface SessionHeaderHookOptions {
	/** 我们注册在 pi 上的 provider 名：只有发往它的请求才带会话头 */
	readonly providerName: string;
	/** 父会话 id 的解析器；测试可注入，生产走默认 */
	readonly resolver?: ParentSessionIdResolver;
}

function sessionKey(ctx: HookContextLike): string {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id !== "" ? id : "";
	} catch {
		return "";
	}
}

function parentSessionPath(ctx: HookContextLike): string | null {
	try {
		const header: unknown = ctx.sessionManager?.getHeader?.();
		if (header === null || typeof header !== "object") return null;
		const raw = (header as Record<string, unknown>).parentSession;
		return typeof raw === "string" && raw.trim() !== "" ? raw : null;
	} catch {
		return null;
	}
}

/**
 * 挂两个钩子。before_agent_start 先记住权威名字，before_provider_headers 才补头；
 * 任何读取/解析失败都吞掉 —— 会话头是附加信息，不能弄坏模型请求。
 *
 * providerName 从 index.ts 传进来：只有发往这个 provider 的请求才带会话头（core 的唯一出口做这个判定）。
 */
export function registerSessionHeaderHooks(pi: SessionHookApi, options: SessionHeaderHookOptions): void {
	const resolver = options.resolver ?? createParentSessionIdResolver();
	const providerName = options.providerName;
	const agents = new Map<string, string>();

	pi.on("before_agent_start", (event, ctx) => {
		try {
			const name = activeAgentName(event.systemPrompt);
			if (name !== null) agents.set(sessionKey(ctx), name);
		} catch {
			// 名字解析失败就走会话名回退，不写空头
		}
	});

	pi.on("before_provider_headers", (event, ctx) => {
		try {
			// 根会话也发自己的 id 与名字；父 id 只在路径存在且解析到时补上
			const parent = parentSessionPath(ctx);
			const manager = ctx.sessionManager;
			if (manager === undefined) return;

			const key = sessionKey(ctx);
			const extra = buildSessionHeaders(
				{
					sessionId: manager.getSessionId?.(),
					parentSessionId: parent === null ? undefined : resolver.resolve(parent, manager.getCwd?.()),
					sessionName: agents.get(key) ?? sessionAgentName(manager.getSessionName?.()),
				},
				// 只有发往我们这个 provider 的请求才带会话头；不是它就一个头都不发
				{ id: ctx.model?.provider, name: providerName },
			);
			if (Object.keys(extra).length === 0 || event.headers === undefined || event.headers === null) return;
			Object.assign(event.headers, extra);
		} catch {
			// 头的问题绝不让模型请求失败
		}
	});
}
