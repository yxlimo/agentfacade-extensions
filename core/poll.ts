// 轮询的机制：间隔怎么配、定时器怎么挂、清单变了怎么记 —— 三个 agent 共用的都在这一层。
// 让新清单生效不在这里（那是各 agent 的注册路径），通知怎么显示也不在：
// core 只在「变了」的那一刻把一行文本交给调用方给的日志通道。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIG_SEGMENTS } from "./gateway-config.ts";

/** 没配任何东西时的默认间隔：5 分钟 */
export const DEFAULT_REFRESH_MS = 300000;

/** 下限：配得更小按 30000 算。轮询比这更密只会打爆网关，换不来任何收益 */
export const MIN_REFRESH_MS = 30000;

export interface ResolveRefreshMsOptions {
  /** host 认的环境变量名，从高到低（共用的那个名字也由调用方给 —— core 不认任何名字） */
  readonly envVarNames?: readonly string[];
  /** 环境变量来源；缺省 process.env */
  env?: NodeJS.ProcessEnv;
  /** 配置文件根（~ 的位置）。测试注入临时目录；缺省真实 home */
  home?: string;
}

/**
 * 环境变量 → config.json 的 `refreshMs` → 默认 300000，最后钳到下限。
 * 这条链**故意宽容**，与地址那条「坏配置就报错」不同：间隔是节奏旋钮不是地址，
 * 写坏只会得到一个不合适的节奏，钳回下限后没有静默危害；
 * 按地址的规矩来会让一次手滑挡住整个模型同步。
 */
export function resolveRefreshMs(options: ResolveRefreshMsOptions = {}): number {
  const env = options.env ?? process.env;
  for (const name of options.envVarNames ?? []) {
    const raw = (env[name] ?? "").trim();
    if (raw === "") continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampRefreshMs(parsed);
  }
  const home = options.home ?? os.homedir();
  const fromConfig = refreshMsFromConfig(home);
  if (fromConfig !== undefined) return clampRefreshMs(fromConfig);
  return DEFAULT_REFRESH_MS;
}

function clampRefreshMs(value: number): number {
  return Math.max(MIN_REFRESH_MS, value);
}

/**
 * 读 config.json 的 `refreshMs`。文件不存在、JSON 坏、不是有限数字 → undefined（当没配）。
 * 与 gateway 的读取分开且更宽容：config.json 对 gateway 是严格的，但这里只是来借一个数字，
 * 不能因为 gateway 那格缺失或写坏就把间隔一起拖下水。
 */
function refreshMsFromConfig(home: string): number | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, ...CONFIG_SEGMENTS), "utf8");
  } catch {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(text);
    const ms = typeof data === "object" && data !== null ? (data as Record<string, unknown>).refreshMs : undefined;
    return typeof ms === "number" && Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/** 注入定时器的形状：返回的对象带 unref 就调（core 不依赖 Node 的 Timeout 类型） */
export interface PollerTimers {
  set(handler: () => void, ms: number): { unref?(): void };
  clear(handle: unknown): void;
}

export interface CatalogPollerOptions {
  intervalMs: number;
  /**
   * 一次轮询：成功交回新清单的模型 id；失败 / 取消 / 没映射出东西交回 null。
   * 交回 null 时 core 不更新基准、不比较、不记日志 —— 保留上一次的好清单是 host 的事。
   */
  poll: () => Promise<readonly string[] | null> | readonly string[] | null;
  /** 首次比较的基准（启动时已经注册出去的那份）；不给则以第一次成功的 poll 为基准 */
  initialIds?: readonly string[];
  /** 变化时的一行日志（host 的 logger/warn 通道）。失败不在这里记 */
  log: (message: string) => void;
  /** 注入定时器（测试用）；缺省 setTimeout + unref */
  timers?: PollerTimers;
}

export interface CatalogPoller {
  /** 已在跑就不再挂第二个定时器 */
  start(): void;
  /** 清掉挂着的定时器；之后 poll 不会再被调 */
  stop(): void;
  readonly running: boolean;
}

const DEFAULT_TIMERS: PollerTimers = {
  set(handler, ms) {
    // unref 由 createCatalogPoller 统一调（见 schedule）：这里只造定时器
    return setTimeout(handler, ms);
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * 清单轮询器。用 setTimeout 链而不是 setInterval：上一次 poll 没回来就不排下一次，
 * 慢网关不会把请求堆起来。模型 id 集合与上次成功那份有增有减才记**一行**日志
 * （重排不算变化：id 集合没变，用户看到的清单就没变）。
 */
export function createCatalogPoller(options: CatalogPollerOptions): CatalogPoller {
  const timers = options.timers ?? DEFAULT_TIMERS;
  let timer: unknown = null;
  let stopped = false;
  let lastIds: readonly string[] | null = options.initialIds ? [...options.initialIds] : null;

  const diffLine = (previous: readonly string[], next: readonly string[]): string | null => {
    const before = new Set(previous);
    const after = new Set(next);
    const added = next.filter((id) => !before.has(id));
    const removed = previous.filter((id) => !after.has(id));
    if (added.length === 0 && removed.length === 0) return null;
    return `model catalog changed: added ${added.length > 0 ? added.join(", ") : "none"}; removed ${
      removed.length > 0 ? removed.join(", ") : "none"
    }`;
  };

  const schedule = (): void => {
    if (stopped) return;
    const handle = timers.set(() => void tick(), options.intervalMs);
    // unref 在这里调而不是塞给每个 timers 实现：注入的假定时器也因此可测
    handle.unref?.();
    timer = handle;
  };
  const tick = async (): Promise<void> => {
    timer = null;
    if (stopped) return;
    let next: readonly string[] | null = null;
    try {
      next = await options.poll();
    } catch {
      // poll 自己抛异常按失败算：保留基准，下一轮再试
      next = null;
    }
    if (!stopped && next !== null) {
      if (lastIds !== null) {
        const line = diffLine(lastIds, next);
        if (line !== null) options.log(line);
      }
      lastIds = [...next];
    }
    if (!stopped) schedule();
  };

  return {
    start() {
      if (stopped || timer !== null) return;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
    },
    get running() {
      return !stopped && timer !== null;
    },
  };
}

/** `<PREFIX>_FACADE_REFRESH_MS` → `FACADE_REFRESH_MS`：环境变量名的拼法只有这一处 */
export function refreshEnvNames(prefix: string): string[] {
  return [`${prefix}_FACADE_REFRESH_MS`, "FACADE_REFRESH_MS"];
}

export interface StartCatalogPollingOptions {
  /** agent 的前缀（`PI` / `DSH` / `OPENCODE`）；环境变量名由它派生 */
  readonly prefix: string;
  /** 拉一次清单：成功交回模型 id，失败 / 取消交回 null */
  refresh: () => Promise<readonly string[] | null>;
  /** 清单**真的变了**才调：让新清单在这个 agent 上生效（重新注册 / 重写配置） */
  apply: () => void | Promise<void>;
  /** 启动时已经交出去的那份；不给则以第一次成功的 refresh 为基准 */
  initialIds?: readonly string[];
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 显式间隔优先于环境变量与配置文件 */
  refreshMs?: number;
  timers?: PollerTimers;
}

/**
 * 定时轮询的**唯一**入口：间隔解析、变化判定、「变了才 apply」都在 core。
 * host 只交两件事——怎么拉一次（refresh）、拉到新清单后怎么生效（apply）；
 * 否则每个 agent 都要把这几步重写一遍，写法一歪就是每轮重写配置。
 */
export function startCatalogPolling(options: StartCatalogPollingOptions): CatalogPoller {
  let known = (options.initialIds ?? []).join("\n");
  const poller = createCatalogPoller({
    intervalMs:
      options.refreshMs ??
      resolveRefreshMs({
        envVarNames: refreshEnvNames(options.prefix),
        env: options.env,
        home: options.home,
      }),
    initialIds: options.initialIds,
    log: options.log,
    timers: options.timers,
    poll: async () => {
      const ids = await options.refresh();
      if (ids === null) return null;
      const next = ids.join("\n");
      if (next !== known) {
        known = next;
        await options.apply();
      }
      return ids;
    },
  });
  poller.start();
  return poller;
}
