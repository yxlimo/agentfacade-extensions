// opencode 插件（v2 API）：`setup` 里拉一次清单 → `editor.add({ info, models })`，**不写任何文件**。
// provider id 独立（`agentfacade`，模型引用写成 `agentfacade/<modelID>`），不与用户已有的 provider 撞名。
// 拉不到 / 清单为空 / 答的不是 JSON 时一律不注册：整表注册空值等于把用户手上的模型清空。

import type { FetchOptions } from "../../core/gateway.ts";
import { syncCatalog, type SyncDeps, type SyncState } from "../../core/sync.ts";
import { API_KEY, PROVIDER_ID } from "./catalog.ts";
import { DEFAULT_PACKAGE, toV2Payload, type OpencodeV2Payload } from "./v2.ts";
import { DEFAULT_TIMEOUT_MS, NO_GATEWAY_HINT, resolveGateway } from "./gateway-config.ts";

const PREFIX = "[facade-models]";

/** 会出现在 opencode 的插件列表里 */
export const PLUGIN_ID = "agentfacade.models";

/** 状态就是 core 的 SyncState；`registered` 本宿主没有维护者（没有显示它的界面） */
export type OpencodeState = SyncState<OpencodeV2Payload>;

export function freshState(): OpencodeState {
  return { gateway: "", from: "", lastGood: [], lastRefresh: null, lastError: null, registered: false };
}

/** 工厂的注入点，只有测试会用；生产路径全走默认值 */
export interface OpencodePluginOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchOptions?: FetchOptions;
  /** 警告去哪。opencode 的插件没有 console 面板，写 stderr 最容易被看见 */
  warn?: (message: string) => void;
  /** 协议包覆盖，默认见 v2.ts 的 DEFAULT_PACKAGE */
  pkg?: string;
  /** provider 的显示名覆盖 */
  displayName?: string;
}

/** cancelled 与失败分开（前者是调用方自己不要了）；成功时把要注册的东西一起交回来 */
export type RefreshResult =
  | { ok: true; payload: OpencodeV2Payload }
  | { ok: false; cancelled: boolean; error: string };

/**
 * 重新解析网关并拉一次清单。失败不改 `lastGood`；被取消时不写 `lastError`（调用方的取消不是网关的错误）。
 */
export async function refresh(
  state: OpencodeState,
  options: OpencodePluginOptions = {},
  signal?: AbortSignal,
): Promise<RefreshResult> {
  const deps: SyncDeps<OpencodeV2Payload> = {
    // 地址优先级是 opencode 的事，core 只拿到排好序的候选
    resolve: () => resolveGateway(options.env ?? process.env, options.home),
    // 清单按 provider 为单位：整份 specs 就是一次注册。`state.gateway` 可以放心读 ——
    // core 在拉清单之前就写回了地址，而 toHost 只在成功那一步被调用。
    toHost: (specs) => [
      toV2Payload(specs, {
        baseUrl: state.gateway,
        apiKey: API_KEY,
        pkg: options.pkg ?? DEFAULT_PACKAGE,
        displayName: options.displayName,
      }),
    ],
    // 超时预算也是 opencode 的：启动路径上会 await 这个 hook
    fetchOptions: {
      ...options.fetchOptions,
      timeoutMs: options.fetchOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  };

  const outcome = await syncCatalog(state, deps, signal);
  if (!outcome.ok) return { ok: false, cancelled: outcome.cancelled, error: outcome.error };

  const payload = state.lastGood.at(-1);
  if (!payload) {
    // 到不了：core 只在 toHost 交出非空清单时报 ok。留着是因为 `.at()` 的类型就是「可能没有」。
    return { ok: false, cancelled: false, error: "the gateway catalog mapped to no provider" };
  }
  return { ok: true, payload };
}

/**
 * v2 宿主上下文只声明用到的那一格：那个包由 opencode 运行时提供，本仓没有这个依赖。
 * 形状来自官方文档的 `ctx.provider.transform((editor) => editor.add({ info, models }))` 用法。
 */
export interface OpencodeV2Editor {
  add(entry: OpencodeV2Payload): void;
}

export interface OpencodeV2Context {
  provider: {
    transform(callback: (editor: OpencodeV2Editor) => void): Promise<unknown>;
    /** v2 的域刷新；本插件不做周期刷新，声明它只是为了让调用方知道它存在 */
    reload?(): Promise<void>;
  };
}

/** 失败一律不注册，用户原有 providers 继续生效。没有「已经注册过」这种记忆，所以文案只说这次 */
export async function setup(
  ctx: OpencodeV2Context,
  options: OpencodePluginOptions = {},
): Promise<void> {
  const state = freshState();
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${PREFIX} ${message}\n`));

  const result = await refresh(state, options);
  if (!result.ok) {
    // 取消是调用方自己的节流，不是网关出问题：安静地什么都不做
    if (result.cancelled) return;
    // 踩的是默认地址时多说一句怎么指别处，否则用户只看到一句 ECONNREFUSED
    const hint = state.from === "default" ? ` ${NO_GATEWAY_HINT}` : "";
    warn(`${result.error} — not registering provider "${PROVIDER_ID}"; the providers in your own config keep working.${hint}`);
    return;
  }

  await ctx.provider.transform((editor) => {
    editor.add(result.payload);
  });
}

/** v2 插件的 default 导出形状：`{ id, setup }`（`Plugin.define()` 是恒等函数，只提供类型） */
export default {
  id: PLUGIN_ID,
  setup,
};
