// pi 这一侧的网关事实：环境变量名、默认地址怎么提示、启动时等多久。
// 解析链与配置文件是三个 agent 共用的，在 core/gateway-config.ts；这里只把 pi 的名字传进去。

import os from "node:os";

import { resolveFacadeGateway, DEFAULT_GATEWAY as CORE_DEFAULT } from "../../core/gateway-config.ts";
import type { ResolvedGateway } from "../../core/gateway.ts";

/** 这一侧的环境变量优先级，从高到低。`FACADE_GATEWAY` 是几个 agent 共用的名字 */
export const GATEWAY_ENV_VARS = ["PI_FACADE_GATEWAY", "FACADE_GATEWAY"] as const;

/**
 * 每级都没配时试这个：`helper/README.md` 把 `http://127.0.0.1:6450` 写成默认地址。
 * 只试这一个、不做局域网扫描 —— pi 的扩展工厂在启动路径上被 await。
 * core 的缺省值导出别名：引用它的既有代码（含测试）不用改。
 */
export const DEFAULT_GATEWAY = CORE_DEFAULT;

/** 默认值也连不上时的提示：既说清怎么指别处，也说明这不是 fatal */
export const NO_GATEWAY_HINT =
  `no gateway configured and the default ${DEFAULT_GATEWAY} is unreachable: set PI_FACADE_GATEWAY, ` +
  "or FACADE_GATEWAY, or run /agentfacade connect <address>, " +
  'or write {"gateway": "http://gateway.example:6450"} to ~/.config/agentfacade/config.json';

/**
 * 启动时等网关的上限：扩展工厂在启动路径上被 await，这个数字等于「网关挂掉时 pi 多等多久」。
 * 1500ms 留了 500ms 余量，保证不可达时不超过 2 秒；core 的 5 秒是通用库预算，必须由 pi 自己传。
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/**
 * PI_FACADE_GATEWAY → FACADE_GATEWAY → ~/.config/agentfacade/config.json
 * → ~/.config/buddy-helper/config.json（兼容）→ `DEFAULT_GATEWAY`。
 * 哪一级赢了、写坏了怎么报都在 core；home 可以传，测试要把配置文件指到临时目录。
 */
export function resolveGateway(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): ResolvedGateway {
  return resolveFacadeGateway({ envVarNames: GATEWAY_ENV_VARS, env, home });
}
