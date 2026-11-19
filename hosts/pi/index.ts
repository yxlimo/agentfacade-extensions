// pi 插件：让 pi 自己在启动时从 AgentFacade 网关拿模型清单，不用手工改 models.json。
//
// 为什么是插件而不是继续写 models.json：写文件是「谁跑过谁才更新」，而网关
// 的模型清单是活的（面板上改一下主路由就变了）。插件在 pi 启动时拉一次，之后
// pi 需要刷新目录时再拉（refreshModels），用户不用记得跑任何命令。
//
// 与 models.json 的关系：这是**替代**，不是并存 —— 模型清单由插件负责，pi 这一侧
// 不再需要人跑命令或手工改 models.json。provider 名独立（agentfacade），不与
// models.json 里可能存在的条目撞名；网关拉不到时本插件不注册，pi 继续用原有清单。
//
// 绝不注册空清单：legacy 形式的 models 是替换语义，注册一个空数组会把用户已有的
// 模型清空，那比「列表过期」糟得多。

import type { FetchOptions } from "../../core/gateway.ts";
import { syncCatalog, type SyncDeps, type SyncState } from "../../core/sync.ts";
import { toPiModelEntry, toProviderConfig, type PiModelEntry, type PiProviderConfig } from "./catalog.ts";
import { DEFAULT_TIMEOUT_MS, NO_GATEWAY_HINT, resolveGateway } from "./gateway-config.ts";

/** provider 名：独立名字，不与 models.json 里可能存在的条目撞名 */
export const PROVIDER_NAME = "agentfacade";

/** 网关跑 public 模式时不校验 key */
export const API_KEY = "public";

/**
 * 这里不用 @earendil-works/pi-coding-agent 的类型：那个包不在本仓的依赖里
 * （插件是给 pi 用的，不是给本仓用的），装上它只为类型会让 typecheck 多一个
 * 几 MB 的依赖。只声明自己用到的两个方法，形状照 docs/extensions.md 的
 * pi.registerProvider / pi.registerCommand。
 */
export interface PiExtensionApi {
  registerProvider(name: string, config: PiProviderConfig & { refreshModels?: RefreshModels }): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: CommandContext) => Promise<void> | void;
    },
  ): void;
}

/** 命令里要用到的那一格；pi 真的 ctx 比这个宽得多 */
export interface CommandContext {
  ui?: { notify?: (message: string, level?: string) => void };
}

/** refreshModels 收到的上下文（docs/extensions.md：canonical credential/stored-catalog/network/signal） */
export interface RefreshContext {
  signal?: AbortSignal;
}

/**
 * refreshModels 的形状：pi 需要刷新目录时调它，**返回值整体替换**已注册的模型。
 * 所以这里永远交回一份非空清单（失败时交回上一次成功的），不交 []。
 */
export type RefreshModels = (context: RefreshContext) => Promise<PiModelEntry[]>;

/** 插件的运行时状态。一份扩展实例一份，命令与 refreshModels 都读它 */
export interface PluginState {
  gateway: string;
  from: string;
  models: PiModelEntry[];
  /** 最后一次成功拉取的时间戳；没成功过是 null */
  lastRefresh: number | null;
  /** 最后一次失败的原因；成功后清掉 */
  lastError: string | null;
  registered: boolean;
}

/** 工厂的注入点，只有测试会用；生产路径全走默认值 */
export interface PluginOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchOptions?: FetchOptions;
  /** 警告去哪里。pi 的扩展没有 console 面板，写 stderr 最容易被看见 */
  warn?: (message: string) => void;
}

const PREFIX = "[facade-models]";

/** refresh() 的结果。cancelled 与失败分开：前者是 pi 自己不要了，不是网关的错 */
export type RefreshResult =
  | { ok: true }
  | { ok: false; cancelled: boolean; error: string };

/**
 * 重新解析网关并拉一次清单。返回拿没拿新清单。
 *
 * 失败时**不改** state.models：上一次成功的那份留着，命令里还能显示，refreshModels
 * 也能把它交回去（返回空列表等于把用户已有的模型清空）。
 *
 * 被调用方取消时**不写** state.lastError：pi 每次注册/凭据变化都会重刷 provider，
 * 新的刷新会把旧的那次 abort 掉，那是它自己的节流方式。把这种取消记成错误，会让
 * 每次正常启动都多一条吓人的警告。
 */
export async function refresh(
  state: PluginState,
  options: PluginOptions = {},
  signal?: AbortSignal,
): Promise<RefreshResult> {
  // 状态机在 core（「拉不到/空清单时绝不替换已有清单」这条要在所有宿主上一致），
  // 这里按字段映射一份给它，而不是把 PluginState 改成 SyncState：PluginState 的形状
  // 已经被 /facade-models 与 describe() 用着，动它会连带搅动 pi 那边的显示逻辑。
  const sync: SyncState<PiModelEntry> = {
    gateway: state.gateway,
    from: state.from,
    lastGood: state.models,
    lastRefresh: state.lastRefresh,
    lastError: state.lastError,
    registered: state.registered,
  };
  const deps: SyncDeps<PiModelEntry> = {
    // 地址优先级是 pi 的事（环境变量名、配置文件位置），core 只拿到排好序的候选
    resolve: () => resolveGateway(options.env ?? process.env, options.home),
    toHost: (specs) => specs.map(toPiModelEntry),
    // 超时预算也是 pi 的：扩展工厂在启动路径上被 await，core 的通用默认值太长
    fetchOptions: { ...options.fetchOptions, timeoutMs: options.fetchOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  };

  const outcome = await syncCatalog(sync, deps, signal);

  // 全部字段回写：core 只改「该改的那几个」，但这边要保证 state 与它一致
  state.gateway = sync.gateway;
  state.from = sync.from;
  state.models = sync.lastGood;
  state.lastRefresh = sync.lastRefresh;
  state.lastError = sync.lastError;
  state.registered = sync.registered;

  return outcome.ok ? { ok: true } : { ok: false, cancelled: outcome.cancelled, error: outcome.error };
}

/** 把 state 变成 pi 的 provider 配置 */
function configFor(state: PluginState, refreshModels: (context: RefreshContext) => Promise<PiModelEntry[]>) {
  return { ...toProviderConfig(state.gateway, API_KEY, state.models), refreshModels };
}

/** 给 /facade-models 用的那几行。英文：用户可见 */
export function describe(state: PluginState): string[] {
  if (!state.registered) {
    const reason = state.lastError ?? "not registered yet";
    return [
      `AgentFacade provider is NOT registered: ${reason}`,
      `Gateway: ${state.gateway || "(none)"}${state.from ? ` (from ${state.from})` : ""}`,
      "Fix the gateway address or start the gateway, then run /facade-models refresh",
    ];
  }
  const when = state.lastRefresh === null ? "never" : new Date(state.lastRefresh).toISOString();
  const lines = [
    `AgentFacade models: ${state.models.length} registered under provider "${PROVIDER_NAME}"`,
    `Gateway: ${state.gateway} (from ${state.from})`,
    `Last refresh: ${when}`,
  ];
  if (state.lastError !== null) lines.push(`Last refresh failed: ${state.lastError}`);
  return lines;
}

/**
 * 扩展工厂。async：pi 会等它返回再继续启动，所以这里拉到的模型对启动时的模型
 * 选择和 `pi --list-models` 都有效（docs/extensions.md 的 async factory 一节）。
 */
export default async function facadeModels(pi: PiExtensionApi, options: PluginOptions = {}): Promise<void> {
  const warn = options.warn ?? ((message: string) => console.warn(`${PREFIX} ${message}`));
  const state: PluginState = {
    gateway: "",
    from: "",
    models: [],
    lastRefresh: null,
    lastError: null,
    registered: false,
  };

  // pi 需要刷新目录时回调这里。失败时把上一次成功的清单交回去 —— pi 会用返回值
  // 替换现有模型，交空数组就是把人家的清单清空。取消则完全安静：那是 pi 自己的节流
  // （新的刷新会把旧的那次 abort），不是网关出问题
  const refreshModels = async (context: RefreshContext): Promise<PiModelEntry[]> => {
    const result = await refresh(state, options, context?.signal);
    if (!result.ok && !result.cancelled) {
      warn(`refresh failed (${result.error}) — keeping the last known ${state.models.length} model(s)`);
    }
    return state.models;
  };

  const start = await refresh(state, options);
  if (start.ok) {
    pi.registerProvider(PROVIDER_NAME, configFor(state, refreshModels));
    state.registered = true;
  } else if (!start.cancelled) {
    // 不注册：此时 models.json 里那条旧清单（如果有）继续生效，pi 照常能用。
    // 踩的是默认地址时多说一句「怎么指别处」—— 否则用户只看到一句 ECONNREFUSED，
    // 不知道默认地址是从哪来的、也不知道有环境变量和配置文件这两个旋钮
    const hint = state.from === "default" ? ` ${NO_GATEWAY_HINT}` : "";
    warn(
      `${start.error} — not registering provider "${PROVIDER_NAME}"; any models.json entry keeps working.${hint}`,
    );
  } else {
    warn(`the first fetch was cancelled before it answered — not registering provider "${PROVIDER_NAME}"`);
  }

  pi.registerCommand("facade-models", {
    description: "Show the AgentFacade gateway model catalog; /facade-models refresh re-fetches it",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "refresh") {
        const result = await refresh(state, options);
        if (result.ok) {
          // 启动之后调用 registerProvider 立刻生效，不用 /reload
          pi.registerProvider(PROVIDER_NAME, configFor(state, refreshModels));
          state.registered = true;
        } else if (!result.cancelled) {
          warn(`refresh failed (${result.error})`);
        }
      }
      const text = describe(state).join("\n");
      if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(text, state.registered ? "info" : "warning");
      else console.log(`${PREFIX} ${text}`);
    },
  });
}
