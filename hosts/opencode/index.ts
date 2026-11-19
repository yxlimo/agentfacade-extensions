// opencode 插件（**v2 API**）：让 opencode 自己从 AgentFacade 网关拿模型清单，不用手工维护 provider 条目。
//
// 为什么是 v2：v1 的插件是「函数返回 hooks，其中 `config` hook 收到解析后的配置对象」；
// v2 要求 default 导出 `{ id, setup(ctx) }`，provider 通过 `ctx.provider.transform()` 注册。
// 把 v1 形状配到 v2.2.7 上会直接加载失败：
//   Plugin must export a default definition with an id and an effect or setup function.
// 所以这里不是「改个名字」，是照 v2 的注册面重写（形状与实测过程见 v2.ts 的头部注释）。
//
// 生效方式：`setup` 里拉一次清单 → `editor.add({ info, models })`。**不写任何文件** ——
// `~/.config/opencode/opencode.jsonc`、`models.jsonc` 一个字节都不动。写文件是「谁跑过谁才更新」，
// 而网关的模型清单是活的（面板上改一下主路由就变了）。
//
// 与用户配置的关系：这是**替代**，不是并存。provider id 独立（`agentfacade`，模型引用写成
// `agentfacade/<modelID>`），不与用户已有的 provider（`buddy` 之类）撞名。
//
// 绝不注册空清单：一个 provider 的模型表是整表，注册空表等于把用户手上能用的模型清空 ——
// 比「列表过期」糟得多。网关拉不到 / 清单为空 / 答的不是 JSON 时**不注册**，用户原有配置
// 继续生效，只留一行警告。

import type { FetchOptions } from "../../core/gateway.ts";
import { syncCatalog, type SyncDeps, type SyncState } from "../../core/sync.ts";
import { API_KEY, PROVIDER_ID } from "./catalog.ts";
import { DEFAULT_PACKAGE, toV2Payload, type OpencodeV2Payload } from "./v2.ts";
import { DEFAULT_TIMEOUT_MS, NO_GATEWAY_HINT, resolveGateway } from "./gateway-config.ts";

const PREFIX = "[facade-models]";

/** 插件 id。v2 要求 default 导出的对象带一个 id，这个串会出现在 opencode 的插件列表里 */
export const PLUGIN_ID = "agentfacade.models";

/**
 * 插件的运行时状态。就是 core 的 SyncState —— 这个宿主直接持有它，少一层字段映射。
 * `registered` 本宿主没有维护者：没有要显示它的界面（命令名 `/facade-models` 是 pi 的说法）。
 */
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
  /** 协议包覆盖（默认见 v2.ts 的 DEFAULT_PACKAGE） */
  pkg?: string;
  /** provider 的显示名覆盖 */
  displayName?: string;
}

/**
 * refresh() 的结果。cancelled 与失败分开：前者是调用方自己不要了，不是网关的错。
 * 成功时把这次要注册的东西也交回来，调用方不必再去 `state.lastGood` 里翻。
 */
export type RefreshResult =
  | { ok: true; payload: OpencodeV2Payload }
  | { ok: false; cancelled: boolean; error: string };

/**
 * 重新解析网关并拉一次清单。
 *
 * 失败时**不改** `state.lastGood`：上一次成功的那份留着，下一次刷新还能把它交回去。
 * 被取消时不写 `state.lastError`：调用方自己的取消不该记成网关的错误。
 */
export async function refresh(
  state: OpencodeState,
  options: OpencodePluginOptions = {},
  signal?: AbortSignal,
): Promise<RefreshResult> {
  const deps: SyncDeps<OpencodeV2Payload> = {
    // 地址优先级是 opencode 的事（环境变量名、配置文件位置），core 只拿到排好序的候选
    resolve: () => resolveGateway(options.env ?? process.env, options.home),
    // 清单按 provider 为单位：整份 specs 就是一次注册。
    // 这里的 `state.gateway` 可以放心读：core 在拉清单**之前**就写回了地址，
    // 而 toHost 只在成功那一步被调用（失败时根本不会问我们要模型）。
    toHost: (specs) => [
      toV2Payload(specs, {
        baseUrl: state.gateway,
        apiKey: API_KEY,
        pkg: options.pkg ?? DEFAULT_PACKAGE,
        displayName: options.displayName,
      }),
    ],
    // 超时预算也是 opencode 的：启动路径上会 await 这个 hook，core 的通用默认值太长
    fetchOptions: {
      ...options.fetchOptions,
      timeoutMs: options.fetchOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  };

  const outcome = await syncCatalog(state, deps, signal);
  if (!outcome.ok) return { ok: false, cancelled: outcome.cancelled, error: outcome.error };

  const payload = state.lastGood.at(-1);
  if (!payload) {
    // 到不了：core 只在 toHost 交出非空清单时才报 ok，而 toHost 永远交一条 provider。
    // 留着这一支是因为 `.at()` 的类型就是「可能没有」，硬转成有会让类型说谎。
    return { ok: false, cancelled: false, error: "the gateway catalog mapped to no provider" };
  }
  return { ok: true, payload };
}

/**
 * v2 宿主上下文：只声明用到的那一格，不去依赖 `@opencode/plugin` 的类型。
 * 那个包由 opencode 运行时提供，本仓没有这个依赖（装上只为类型不划算）；
 * 形状来自官方文档里 `ctx.provider.transform((editor) => editor.add({ info, models }))` 的用法，
 * 并已用真机验证（`opencode models` 里出现我们注册的 provider）。
 */
export interface OpencodeV2Editor {
  add(entry: OpencodeV2Payload): void;
}

export interface OpencodeV2Context {
  provider: {
    transform(callback: (editor: OpencodeV2Editor) => void): Promise<unknown>;
    /** v2 的域刷新；本插件目前不做周期刷新，留着这一格是为了让调用方知道它存在 */
    reload?(): Promise<void>;
  };
}

/**
 * v2 的入口体。失败一律**不注册**：用户原有 providers 继续生效。
 *
 * 文案按事实说话：没有「已经注册过」这种记忆（opencode 重载插件会重新 setup），
 * 所以只说「这次没有注册」。
 */
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
    // 踩的是默认地址时多说一句「怎么指别处」—— 否则用户只看到一句 ECONNREFUSED，
    // 不知道默认地址是从哪来的、也不知道有环境变量和配置文件这两个旋钮
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
