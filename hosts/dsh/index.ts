// dsh 插件：启动时从 AgentFacade 网关拉模型清单，写进自己的 llm-pi-ai 配置。
// 只调 ctx.settings（宿主自己的持久化 API）；cordis.patch.yml / settings.yaml 是用户的家产，插件不碰，
// 拿不到可用的写入 API 就报错说明，**不**降级成写文件。每条分叉都留下痕迹：state.writePath、日志、describe()。

import type { FetchOptions } from "../../core/gateway.ts";
import { syncCatalog, type SyncDeps, type SyncState } from "../../core/sync.ts";
import { DEFAULT_API, DEFAULT_API_KEY_ENV, DEFAULT_DISPLAY_NAME, toProviderProfile, type PiAiProviderProfile } from "./provider.ts";
import { DEFAULT_TIMEOUT_MS, resolveDshGateway } from "./gateway-source.ts";
import { pickNamespace, probeCapabilities, writeProvider, type Capabilities, type SettingsHost } from "./settings-sync.ts";

/** 插件名（cordis 侧显示用） */
export const name = "agentfacade-models";

/** provider 路由名：独立名字，不与用户已有的路由（buddy / minimax-code …）撞名 */
export const PROVIDER_NAME = "agentfacade";

/** 日志前缀。dsh 的日志里一眼能捞出来 */
const PREFIX = "[agentfacade-models/dsh]";

/** dsh 传给插件的 context 里本插件用到的部分：只声明用到的成员，形状照已安装包的 `.d.ts` 缩到最小 */
export interface DshPluginContext {
  settings?: SettingsHost;
  /** 宿主的日志通道；没有就退到 console */
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void };
  /** 宿主启动时可以带取消信号；测试构造假的即可 */
  signal?: AbortSignal;
}

/** 插件配置（cordis patch 里 `config:` 那一格）。全部字段都有默认值 */
export interface DshPluginConfig {
  /** provider 路由名，默认 agentfacade */
  providerName?: string;
  /** 上游协议，默认 openai-completions */
  api?: string;
  /** 密钥环境变量名，默认见 DEFAULT_API_KEY_ENV；**不写密钥本身** */
  apiKeyEnv?: string;
  /** provider 展示名 */
  displayName?: string;
  /** 网关地址（最高优先）；不配就按 DSH_FACADE_GATEWAY → FACADE_GATEWAY → 默认地址 */
  gateway?: string;
  /** 读环境变量用的注入点（测试用） */
  env?: NodeJS.ProcessEnv;
  /** 注入 fetch（测试用；生产走全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 启动时等网关的上限（毫秒） */
  timeoutMs?: number;
  /** 警告通道；默认 console.warn */
  warn?: (message: string) => void;
}

/** 插件的运行时状态。一份插件实例一份；第二次 apply 可以复用（测试与热重载） */
export interface DshState {
  /** 选中的 settings ns；没找到是 null */
  ns: string | null;
  /** 最近一次映射出的 provider profile。拉失败时**保持上一次**，不置空 */
  lastGood: PiAiProviderProfile | null;
  gateway: string;
  from: string;
  lastRefresh: number | null;
  lastError: string | null;
  /** 实际走的分叉（`mutate+revision` / `replace` / …）；空串表示还没写过 */
  writePath: string;
  /** 能力探测只做一次，缓存这里 */
  capabilities: Capabilities | null;
}

/** apply 的结果。ok:false 时 error 是给人看的一句话 */
export type SyncReport =
  | { ok: true; ns: string; writePath: string; models: number; gateway: string; from: string }
  | { ok: false; cancelled: boolean; ns: string | null; writePath: string; gateway: string; from: string; error: string };

/** 新状态。测试可以自己造一份传给 apply 复用 */
export function createState(): DshState {
  return { ns: null, lastGood: null, gateway: "", from: "", lastRefresh: null, lastError: null, writePath: "", capabilities: null };
}

/** 插件入口。apply 在启动路径上被 await，第一次请求前 provider 必须就位；第三个参数只为测试注入状态 */
export async function apply(ctx: DshPluginContext, config: DshPluginConfig = {}, state: DshState = createState()): Promise<SyncReport> {
  const warn = pickWarn(ctx, config);
  const log = (message: string): void => {
    const line = `${PREFIX} ${message}`;
    if (typeof ctx.logger?.info === "function") ctx.logger.info(line);
    else console.log(line);
  };

  const settings = ctx.settings;
  if (!settings || typeof settings.describe !== "function") {
    return fail(state, warn, "the context has no settings service with describe(); cannot register the agentfacade route", PREFIX);
  }

  let descriptors;
  try {
    descriptors = settings.describe();
  } catch (error) {
    return fail(state, warn, `settings.describe() threw: ${messageOf(error)}`, PREFIX);
  }

  // 能力探测只做一次：结果一次性算好缓存，不要每次调用都判定
  if (state.capabilities === null) state.capabilities = probeCapabilities(settings);
  const caps = state.capabilities;
  if (caps.problems.length > 0) {
    for (const problem of caps.problems) warn(`${PREFIX} ${problem}`);
    return fail(state, warn, caps.problems[0], PREFIX, { silent: true });
  }

  const picked = pickNamespace(descriptors);
  if (!picked.ok) {
    return fail(state, warn, picked.error, PREFIX);
  }
  state.ns = picked.descriptor.ns;

  const providerName = config.providerName ?? PROVIDER_NAME;
  const api = config.api ?? DEFAULT_API;
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;

  const resolved = resolveDshGateway({ gateway: config.gateway, env: config.env });
  if (!resolved.ok) {
    // 地址写错时 core 已经带上下文；这里不覆盖 state.gateway/from
    return fail(state, warn, resolved.error, PREFIX);
  }

  const sync: SyncState<PiAiProviderProfile> = {
    gateway: state.gateway,
    from: state.from,
    lastGood: state.lastGood === null ? [] : [state.lastGood],
    lastRefresh: state.lastRefresh,
    lastError: state.lastError,
    registered: false,
  };

  const fetchOptions: FetchOptions = {
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  const deps: SyncDeps<PiAiProviderProfile> = {
    resolve: () => resolved,
    // 宿主形状的映射：网关地址由 deps.resolve 给出，映射只换字段（provider.ts）
    toHost: (specs) => [toProviderProfile(specs, { baseUrl: resolved.gateway, api, apiKeyEnv, displayName })],
    fetchOptions,
  };

  const outcome = await syncCatalog(sync, deps, ctx.signal);

  // 全部字段回写：core 只改「该改的那几个」，这边保证 state 与它一致
  state.gateway = sync.gateway;
  state.from = sync.from;
  state.lastRefresh = sync.lastRefresh;
  state.lastError = sync.lastError;
  state.lastGood = sync.lastGood.length === 0 ? null : sync.lastGood[0];

  if (!outcome.ok) {
    // 失败与取消分开：取消是宿主自己的节流（新的刷新会 abort 旧的），不是网关出问题
    if (!outcome.cancelled) {
      warn(`${PREFIX} ${outcome.error} — keeping the last known ${state.lastGood?.models.length ?? 0} model(s); nothing written`);
    }
    return {
      ok: false,
      cancelled: outcome.cancelled,
      ns: state.ns,
      writePath: state.writePath,
      gateway: state.gateway,
      from: state.from,
      error: outcome.error,
    };
  }

  const value = outcome.models[0];
  const write = await writeProvider({ host: settings, caps, descriptor: picked.descriptor, providerName, value });
  if (!write.ok) {
    state.lastError = write.error ?? "settings write failed";
    return fail(state, warn, state.lastError, PREFIX);
  }

  state.writePath = write.path;
  state.lastError = null;
  log(
    `wrote providers.${providerName} ("${picked.matchedBy}" matched) to settings entry "${state.ns}" via ${write.path}, ` +
      `${value.models.length} model(s), api=${value.api}, baseURL=${value.baseURL}`,
  );
  return { ok: true, ns: state.ns, writePath: state.writePath, models: value.models.length, gateway: state.gateway, from: state.from };
}

/** 给用户看的那几行，文案是 dsh 的说法；排障时能一眼看出走的是哪条分叉 */
export function describe(state: DshState): string[] {
  const when = state.lastRefresh === null ? "never" : new Date(state.lastRefresh).toISOString();
  const lines = [
    state.lastGood === null
      ? "AgentFacade route: NOT registered"
      : `AgentFacade route: ${state.lastGood.models.length} model(s) under provider "${PROVIDER_NAME}"`,
    `Gateway: ${state.gateway || "(none)"}${state.from ? ` (from ${state.from})` : ""}`,
    `Settings entry: ${state.ns ?? "(not found yet)"}`,
    `Write path: ${state.writePath || "(nothing written yet)"}`,
    `Last refresh: ${when}`,
  ];
  if (state.lastError !== null) lines.push(`Last error: ${state.lastError}`);
  return lines;
}

function pickWarn(ctx: DshPluginContext, config: DshPluginConfig): (message: string) => void {
  if (typeof config.warn === "function") return config.warn;
  if (typeof ctx.logger?.warn === "function") return ctx.logger.warn.bind(ctx.logger);
  return (message: string) => console.warn(message);
}

/**
 * 失败出口。`silent` 用于「配置问题已经逐条 warn 过」的情况，避免同一条重复两遍；state.lastError 永远写上。
 */
function fail(state: DshState, warn: (message: string) => void, message: string, prefix: string, options: { silent?: boolean } = {}): SyncReport {
  state.lastError = message;
  if (!options.silent) warn(`${prefix} ${message}`);
  return { ok: false, cancelled: false, ns: state.ns, writePath: state.writePath, gateway: state.gateway, from: state.from, error: message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
