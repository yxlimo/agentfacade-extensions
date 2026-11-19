// 同步状态机：解析地址 → 拉清单 → 决定「换不换」。
// 「拉不到 / 空清单都绝不替换已有清单」这条必须在所有 agent 上一致，漏掉的后果是把用户手上的模型整表清零。
// 通知怎么显示不在这里：core 只说这次算不算失败、是不是调用方自己取消的。

import { fetchCatalog } from "./gateway.ts";
import type { FetchOptions, ResolvedGateway } from "./gateway.ts";
import type { ModelSpec } from "./types.ts";

/** 状态：字段名是 core 的说法，agent 可以持有它也可以映射到自己字段；`lastGood` 的形状由 agent 定 */
export interface SyncState<Model> {
  /** 解析失败时保持上一次的值，不动 */
  gateway: string;
  /** 地址是从哪一级来的；名字由 agent 起，core 原样存着 */
  from: string;
  /** 最后一次成功的清单；**只在拿到非空清单时替换** */
  lastGood: Model[];
  /** 从没成功过是 null */
  lastRefresh: number | null;
  /** 成功后清掉，取消时不动 */
  lastError: string | null;
  /** 注册是 agent 的事，core 不改它 */
  registered: boolean;
}

/** 一次同步的外部依赖，全部由 agent 注入：core 不认环境变量、不读配置文件 */
export interface SyncDeps<Model> {
  /** 地址解析。失败（地址写错）也要有结果，不要抛 */
  resolve(): ResolvedGateway;
  /** ModelSpec → agent 自己的模型形状 */
  toHost(specs: readonly ModelSpec[]): Model[];
  fetchOptions?: FetchOptions;
  now?: () => number;
}

/** 两条分支都带 `models`：失败时是上一次成功的那份，不是空数组 */
export type SyncOutcome<Model> =
  | { ok: true; models: Model[] }
  | { ok: false; cancelled: boolean; error: string; models: Model[] };

/**
 * 重新解析地址并拉一次清单。失败不改 `lastGood`；被取消时不写 `lastError`（那是调用方的节流，不是错误）。
 */
export async function syncCatalog<Model>(
  state: SyncState<Model>,
  deps: SyncDeps<Model>,
  signal?: AbortSignal,
): Promise<SyncOutcome<Model>> {
  const resolved = deps.resolve();
  if (!resolved.ok) {
    // 不覆盖 state.gateway/from：清掉它就看不出「原来指哪」了
    state.lastError = resolved.error;
    return { ok: false, cancelled: false, error: resolved.error, models: state.lastGood };
  }
  // 先写回地址再拉：拉失败时 agent 也要能显示「试的是哪个地址、从哪来的」
  state.gateway = resolved.gateway;
  state.from = resolved.from;

  const listed = await fetchCatalog(resolved.gateway, { ...deps.fetchOptions, signal });
  if (!listed.ok) {
    if (listed.cancelled) {
      return { ok: false, cancelled: true, error: listed.error, models: state.lastGood };
    }
    state.lastError = listed.error;
    return { ok: false, cancelled: false, error: listed.error, models: state.lastGood };
  }

  const models = deps.toHost(listed.specs);
  // 网关给了清单但一条都映射不出来：同样不能拿去替换
  if (models.length === 0) {
    const error = `${state.gateway}/v1/models mapped to zero usable models — keeping the previous list`;
    state.lastError = error;
    return { ok: false, cancelled: false, error, models: state.lastGood };
  }

  state.lastGood = models;
  state.lastRefresh = deps.now ? deps.now() : Date.now();
  state.lastError = null;
  return { ok: true, models };
}
