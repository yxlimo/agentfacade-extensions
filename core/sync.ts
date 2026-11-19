// 同步状态机：解析地址 → 拉清单 → 决定「换不换」。
//
// 为什么这件事必须在 core 而不是各宿主各写一遍：所有宿主对「拉不到时怎么办」必须给出
// 同一个答案 —— 空清单与失败都**不能**替换手上已有的清单。谁自己写一遍，谁就可能漏掉
// 这一条，而漏掉的后果是 legacy 形式的 models 被整条替换成空数组，用户原有的模型清零。
// 那不是「列表过期」，那是把能用的东西弄没了。
//
// 通知怎么显示不在这里：core 只说这次算不算失败、是不是调用方自己取消的，文案与通道由宿主给。

import { fetchCatalog } from "./gateway.ts";
import type { FetchOptions, ResolvedGateway } from "./gateway.ts";
import type { ModelSpec } from "./types.ts";

/**
 * 状态。字段名是 core 的说法，宿主可以直接持有它，也可以映射到自己的状态字段上。
 *
 * `lastGood` 的类型交给宿主：宿主注册出去的是自己的配置形状，core 不去猜它长什么样。
 */
export interface SyncState<Model> {
  /** 当前用的网关根地址。解析失败时保持上一次的值，不动 */
  gateway: string;
  /** 地址是从哪一级来的；名字由宿主起，core 原样存着 */
  from: string;
  /** 最后一次成功的清单（宿主形状）。**只在拿到非空清单时替换** */
  lastGood: Model[];
  /** 最后一次成功的时间戳；从没成功过是 null */
  lastRefresh: number | null;
  /** 最后一次失败的原因；成功后清掉，取消时不动 */
  lastError: string | null;
  /** 宿主有没有把清单注册出去。core 不改它 —— 注册是宿主的事 */
  registered: boolean;
}

/** 一次同步的外部依赖，全部由宿主注入：core 不认环境变量、不认配置文件 */
export interface SyncDeps<Model> {
  /** 地址解析。失败（地址写错）也要有结果，不要抛 */
  resolve(): ResolvedGateway;
  /** ModelSpec → 宿主自己的模型形状 */
  toHost(specs: readonly ModelSpec[]): Model[];
  fetchOptions?: FetchOptions;
  /** 注入时钟，测试用 */
  now?: () => number;
}

/**
 * 一次同步的结果。
 *
 * 两条分支都带 `models`：调用方要交回给宿主的东西永远是「现在能用的那份」。
 * 失败时它不是空数组，而是上一次成功的那份 —— 返回值语义就这一句。
 */
export type SyncOutcome<Model> =
  | { ok: true; models: Model[] }
  | { ok: false; cancelled: boolean; error: string; models: Model[] };

/**
 * 重新解析地址并拉一次清单，返回拿没拿到新清单。
 *
 * 失败时**不改** `state.lastGood`：上一次成功的那份留着，宿主的命令里还能显示，
 * 刷新回调也能把它交回去（交回空数组等于把用户的模型清空）。
 *
 * 被调用方取消时**不写** `state.lastError`：宿主每次注册/凭据变化都可能重刷，
 * 新的刷新会把旧的那次 abort 掉 —— 那是它自己的节流方式。把这种取消记成错误，
 * 会让每次正常启动都多一条吓人的警告。
 */
export async function syncCatalog<Model>(
  state: SyncState<Model>,
  deps: SyncDeps<Model>,
  signal?: AbortSignal,
): Promise<SyncOutcome<Model>> {
  const resolved = deps.resolve();
  if (!resolved.ok) {
    // 地址写错时不覆盖 state.gateway/from：那是上一次真实用过的地址，
    // 清掉它会让命令里连「原来指哪」都看不出来
    state.lastError = resolved.error;
    return { ok: false, cancelled: false, error: resolved.error, models: state.lastGood };
  }
  // 先写回地址再拉：拉失败时宿主也要能显示「试的是哪个地址、从哪来的」
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
  // 网关给了清单但宿主一条都映射不出来（字段全不认识之类）：同样不能拿去替换
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
