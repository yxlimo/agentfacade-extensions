// pi 插件：启动时从 AgentFacade 网关拉模型清单并注册 provider，替代手工维护 models.json。
// provider 名独立（agentfacade），不与 models.json 里可能存在的条目撞名；拉不到就不注册，pi 继续用原有清单。
// 绝不注册空清单：legacy 形式的 models 是替换语义，注册空数组会把用户已有的模型清空。

import os from "node:os";

import { normalizeGatewayInput, writeFacadeConfig } from "../../core/gateway-config.ts";
import type { FetchOptions } from "../../core/gateway.ts";
import { syncCatalog, type SyncDeps, type SyncState } from "../../core/sync.ts";
import { toPiModelEntry, toProviderConfig, type PiModelEntry, type PiProviderConfig } from "./catalog.ts";
import { DEFAULT_TIMEOUT_MS, NO_GATEWAY_HINT, resolveGateway } from "./gateway-config.ts";

/** provider 名：独立名字，不与 models.json 里可能存在的条目撞名 */
export const PROVIDER_NAME = "agentfacade";

/** 网关跑 public 模式时不校验 key */
export const API_KEY = "public";

/** 不 import @earendil-works/pi-coding-agent 的类型：那个包不在本仓依赖里，只声明自己用到的两个方法 */
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

/** refreshModels 收到的上下文（docs/extensions.md 的 credential/stored-catalog/network/signal）；本插件只用 signal */
export interface RefreshContext {
  signal?: AbortSignal;
}

/** **返回值整体替换**已注册的模型：所以永远交回非空清单，不交 [] */
export type RefreshModels = (context: RefreshContext) => Promise<PiModelEntry[]>;

/** 插件的运行时状态。一份扩展实例一份，命令与 refreshModels 都读它 */
export interface PluginState {
  gateway: string;
  from: string;
  models: PiModelEntry[];
  lastRefresh: number | null;
  /** 成功后清掉 */
  lastError: string | null;
  registered: boolean;
}

/** 工厂的注入点，只有测试会用；生产路径全走默认值 */
export interface PluginOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchOptions?: FetchOptions;
  /** 警告去哪。pi 的扩展没有 console 面板，写 stderr 最容易被看见 */
  warn?: (message: string) => void;
}

const PREFIX = "[facade-models]";

/** cancelled 与失败分开：前者是 pi 自己不要了，不是网关的错 */
export type RefreshResult =
  | { ok: true }
  | { ok: false; cancelled: boolean; error: string };

/**
 * 重新解析网关并拉一次清单。失败不改 state.models；被取消时不写 state.lastError（那是 pi 自己的节流）。
 */
export async function refresh(
  state: PluginState,
  options: PluginOptions = {},
  signal?: AbortSignal,
): Promise<RefreshResult> {
  // 状态机在 core；这里按字段映射一份给它，而不是把 PluginState 改成 SyncState ——
  // 后者的形状已经被 /facade-models 与 describe() 用着，动它会连带搅动显示逻辑。
  const sync: SyncState<PiModelEntry> = {
    gateway: state.gateway,
    from: state.from,
    lastGood: state.models,
    lastRefresh: state.lastRefresh,
    lastError: state.lastError,
    registered: state.registered,
  };
  const deps: SyncDeps<PiModelEntry> = {
    // 地址优先级是 pi 的事，core 只拿到排好序的候选
    resolve: () => resolveGateway(options.env ?? process.env, options.home),
    toHost: (specs) => specs.map(toPiModelEntry),
    // 超时预算也是 pi 的：扩展工厂在启动路径上被 await
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

function configFor(state: PluginState, refreshModels: (context: RefreshContext) => Promise<PiModelEntry[]>) {
  return { ...toProviderConfig(state.gateway, API_KEY, state.models), refreshModels };
}

/** 给 /agentfacade（与别名 /facade-models）用的那几行。英文：用户可见 */
export function describe(state: PluginState): string[] {
  if (!state.registered) {
    const reason = state.lastError ?? "not registered yet";
    return [
      `AgentFacade provider is NOT registered: ${reason}`,
      `Gateway: ${state.gateway || "(none)"}${state.from ? ` (from ${state.from})` : ""}`,
      "Fix the gateway address or start the gateway, then run /agentfacade refresh",
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

/** async 工厂：pi 会等它返回再继续启动，所以这里拉到的模型对启动时的模型选择都有效 */
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

  // pi 用返回值整体替换现有模型：失败时交回上一次成功的清单，取消则完全安静
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
    // 不注册：models.json 里那条旧清单（如果有）继续生效，pi 照常能用。
    // 踩的是默认地址时多说一句怎么指别处，否则用户只看到一句 ECONNREFUSED。
    const hint = state.from === "default" ? ` ${NO_GATEWAY_HINT}` : "";
    warn(
      `${start.error} — not registering provider "${PROVIDER_NAME}"; any models.json entry keeps working.${hint}`,
    );
  } else {
    warn(`the first fetch was cancelled before it answered — not registering provider "${PROVIDER_NAME}"`);
  }

  /**
   * connect 的写文件落在 core（writeFacadeConfig）：失败时返回错误而不是抛，
   * state 一个字段都没被碰 —— 内存里的地址原样保留，这是「写失败不改内存地址」的实现位置。
   */
  const connect = async (rawTarget: string, ctx: CommandContext): Promise<void> => {
    const notify = (text: string): void => {
      if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(text, "warning");
      else console.log(`${PREFIX} ${text}`);
    };
    const normalized = normalizeGatewayInput(rawTarget);
    if (!normalized.ok) {
      notify(`connect: ${normalized.error} — nothing written`);
      return;
    }
    const written = writeFacadeConfig(options.home ?? os.homedir(), normalized.url);
    if (!written.ok) {
      notify(`connect: ${written.error} — keeping the current gateway ${state.gateway || "(none)"}`);
      return;
    }
    // 写完立刻刷新一次。拉不到只报告原因、不回滚文件：换网络是正常操作（docs/design.md）
    const result = await refresh(state, options);
    if (result.ok) {
      pi.registerProvider(PROVIDER_NAME, configFor(state, refreshModels));
      state.registered = true;
    }
    const lines = [`connect: gateway written to ${written.file}`, ...describe(state)];
    if (!result.ok && !result.cancelled) {
      lines.push(`refresh failed: ${result.error} — the file keeps the new address, retry when the gateway is reachable`);
    }
    const text = lines.join("\n");
    if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(text, state.registered ? "info" : "warning");
    else console.log(`${PREFIX} ${text}`);
  };

  const handleCommand = async (args: string, ctx: CommandContext): Promise<void> => {
    const trimmed = args.trim();
    if (/^connect\b/i.test(trimmed)) {
      const target = trimmed.replace(/^connect\b/i, "").trim();
      if (target === "") {
        if (typeof ctx?.ui?.notify === "function") ctx.ui.notify("usage: /agentfacade connect <address>", "warning");
        else console.log(`${PREFIX} usage: /agentfacade connect <address>`);
        return;
      }
      await connect(target, ctx);
      return;
    }
    if (trimmed.toLowerCase() === "refresh") {
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
  };

  pi.registerCommand("agentfacade", {
    description: "Show the AgentFacade gateway model catalog; /agentfacade connect <address> writes ~/.config/agentfacade/config.json and re-fetches; refresh re-fetches",
    handler: handleCommand,
  });
  // 别名：老名字保留
  pi.registerCommand("facade-models", {
    description: "Alias of /agentfacade",
    handler: handleCommand,
  });
}
