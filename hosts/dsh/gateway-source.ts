// dsh 这一侧的网关事实：地址从哪来、启动时等多久。
// 与 pi 的差别：dsh 没有那层手写的 JSON 配置（用户侧是 cordis profile patch，插件不碰），
// 所以只有「插件配置 → 环境变量 → 默认地址」三级。环境变量名与默认地址是这套部署的约定，core 不认名字。

import { resolveGateway as pickGateway, type ResolvedGateway } from "../../core/gateway.ts";

/**
 * 每级都没配时试这个：6450 是本机网关的监听端口（`helper/README.md` 写的就是它）。
 * dsh 与 pi 常常跑在同一台机器、对着同一个网关，所以沿用；只试这一个、不做网段扫描。
 */
export const DEFAULT_GATEWAY = "http://127.0.0.1:6450";

/** dsh 侧认的环境变量名，从高到低 */
export const GATEWAY_ENV_VARS = ["DSH_FACADE_GATEWAY", "FACADE_GATEWAY"] as const;

/**
 * 启动时等网关的上限：apply 在启动路径上被 await，这个数字等于「网关挂掉时 dsh 多等多久」。
 * 取 2 秒，与 pi 的 1.5 秒同一量级；core 的 5 秒是通用库预算，不该由它决定宿主要等多久。
 */
export const DEFAULT_TIMEOUT_MS = 2000;

export interface GatewayOptions {
  /** 插件配置里的 gateway（显式指定时最高优先） */
  gateway?: string;
  env?: NodeJS.ProcessEnv;
}

/** 地址写错（不是 http(s)）时 core 报错，不悄悄换下一级 */
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
