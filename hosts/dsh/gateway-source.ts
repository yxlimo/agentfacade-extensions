// dsh 这一侧的网关事实：地址从哪来、启动时等多久。
//
// 为什么留在 dsh 而不是 core：环境变量名（DSH_FACADE_GATEWAY / FACADE_GATEWAY）与
// 默认地址是这套部署的约定，别的宿主没有这一套。core 的 resolveGateway 只接收
// 「排好序的候选 + 读取器」，不认任何名字。
//
// 与 pi 宿主的差别：pi 还有一层 ~/.config/buddy-helper/config.json（手动写的 JSON），
// dsh 这边的用户侧配置是 cordis profile patch，由 dsh 自己维护；插件不碰它，
// 所以这里只有「插件配置 → 环境变量 → 默认地址」三级。

import { resolveGateway as pickGateway, type ResolvedGateway } from "../../core/gateway.ts";

/**
 * 每级都没配时试这个。
 *
 * 6450 是本机网关的监听端口（helper/README.md 把 http://127.0.0.1:6450 写成默认地址，
 * 实测返回同一份清单）。dsh 与 pi 常常跑在同一台机器上、对着同一个网关，所以沿用。
 * 只试这一个、不做网段扫描：插件在 dsh 启动路径上被 await，拿启动延迟换一次没把握
 * 的发现不划算。
 */
export const DEFAULT_GATEWAY = "http://127.0.0.1:6450";

/** dsh 侧认的环境变量名，从高到低 */
export const GATEWAY_ENV_VARS = ["DSH_FACADE_GATEWAY", "FACADE_GATEWAY"] as const;

/**
 * 启动时等网关的上限。
 *
 * 插件的 apply 在 dsh 启动路径上被 await（设置写入要赶在第一次请求前落地），这个数字
 * 直接等于「网关挂掉时 dsh 多等多久」。core 的默认 5 秒是通用库预算，不该由它决定
 * 一个交互式宿主要等多久；这里取 2 秒，与 pi 宿主的 1.5 秒同一量级。
 */
export const DEFAULT_TIMEOUT_MS = 2000;

export interface GatewayOptions {
  /** 插件配置里的 gateway（显式指定时最高优先） */
  gateway?: string;
  env?: NodeJS.ProcessEnv;
}

/** 这次要用的网关地址与来源。地址写错（不是 http(s)）时 core 报错，不悄悄换下一级 */
export function resolveDshGateway(options: GatewayOptions = {}): ResolvedGateway {
  const env = options.env ?? process.env;
  return pickGateway({
    candidates: [
      { from: "plugin config", value: options.gateway ?? "" },
      ...GATEWAY_ENV_VARS.map((name) => ({ from: name, value: env[name] ?? "" })),
    ],
    fallback: DEFAULT_GATEWAY,
  });
}
