// dsh 这一侧的网关事实：插件配置与环境变量名、启动时等多久。
// 解析链与配置文件是三个 agent 共用的，在 core/gateway-config.ts；这里把 dsh 的名字与
// 插件配置（最高优先的 extra candidate）传进去。core 不认任何名字。


import { resolveFacadeGateway, DEFAULT_GATEWAY as CORE_DEFAULT, type GatewayCandidate } from "../../core/gateway-config.ts";
import type { ResolvedGateway } from "../../core/gateway.ts";

/**
 * 每级都没配时试这个：6450 是本机网关的监听端口（`helper/README.md` 写的就是它）。
 * dsh 与 pi 常常跑在同一台机器、对着同一个网关，所以沿用；只试这一个、不做网段扫描。
 * core 的缺省值导出别名：引用它的既有代码（含测试）不用改。
 */
export const DEFAULT_GATEWAY = CORE_DEFAULT;

/** dsh 侧认的环境变量名，从高到低。`FACADE_GATEWAY` 是几个 agent 共用的名字 */
export const GATEWAY_ENV_VARS = ["DSH_FACADE_GATEWAY", "FACADE_GATEWAY"] as const;

/**
 * 启动时等网关的上限：apply 在启动路径上被 await，这个数字等于「网关挂掉时 dsh 多等多久」。
 * 取 2 秒，与 pi 的 1.5 秒同一量级；core 的 5 秒是通用库预算，不该由它决定 agent 要等多久。
 */
export const DEFAULT_TIMEOUT_MS = 2000;

export interface GatewayOptions {
  /** 插件配置里的 gateway（显式指定时最高优先） */
  gateway?: string;
  env?: NodeJS.ProcessEnv;
  /** 配置文件根（~ 的位置）。测试注入临时目录，绝不碰真实主目录 */
  home?: string;
}

/**
 * 插件配置 → DSH_FACADE_GATEWAY → FACADE_GATEWAY → ~/.config/agentfacade/config.json
 * → ~/.config/buddy-helper/config.json（兼容）→ `DEFAULT_GATEWAY`。
 * 地址写错（不是 http(s)）、配置文件写坏都在 core 报错，不悄悄换下一级。
 */
export function resolveDshGateway(options: GatewayOptions = {}): ResolvedGateway {
  const extra: readonly GatewayCandidate[] =
    options.gateway === undefined ? [] : [{ from: "plugin config", value: options.gateway }];
  return resolveFacadeGateway({
    extraCandidates: extra,
    envVarNames: GATEWAY_ENV_VARS,
    env: options.env ?? process.env,
    // home 不给时由 core 用真实主目录；这里不 import node:os —— dsh 的红线扫描不许配置来源碰文件系统
    home: options.home,
  });
}
