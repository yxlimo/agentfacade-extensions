// opencode 这一侧的网关事实：环境变量名、默认地址怎么提示、config hook 等多久。
// 解析链与配置文件是三个 agent 共用的，在 core/gateway-config.ts；这里只把 opencode 的名字传进去。

import os from "node:os";

import { resolveFacadeGateway, DEFAULT_GATEWAY as CORE_DEFAULT } from "../../core/gateway-config.ts";
import type { ResolvedGateway } from "../../core/gateway.ts";

/**
 * 这一侧的环境变量优先级，从高到低。`FACADE_GATEWAY` 是几个 agent 共用的名字：同一台机器上网关只有一个。
 */
export const GATEWAY_ENV_VARS = ["OPENCODE_FACADE_GATEWAY", "FACADE_GATEWAY"] as const;

/**
 * 每级都没配时试这个：`helper/README.md` 把 `http://127.0.0.1:6450` 写成默认地址。
 * 只试这一个、不做局域网扫描：config hook 在启动路径上被 await，猜错等于对着错的网关取清单。
 * core 的缺省值导出别名：引用它的既有代码（含测试）不用改。
 */
export const DEFAULT_GATEWAY = CORE_DEFAULT;

/** 默认值也连不上时的提示：既说清怎么指别处，也说明这不是 fatal */
export const NO_GATEWAY_HINT =
  `no gateway configured and the default ${DEFAULT_GATEWAY} is unreachable: set OPENCODE_FACADE_GATEWAY, ` +
  "or FACADE_GATEWAY, " +
  'or write {"gateway": "http://gateway.example:6450"} to ~/.config/agentfacade/config.json';

/**
 * config hook 里等网关的上限：opencode 在解析完配置后 await 每个插件的 config hook，这个数字等于
 * 「网关挂掉时 opencode 启动多等多久」。1500ms 与 pi 取同一个数（连接被拒立即返回，只有连得上不回话才吃满）。
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/**
 * OPENCODE_FACADE_GATEWAY → FACADE_GATEWAY → ~/.config/agentfacade/config.json
 * → ~/.config/buddy-helper/config.json（兼容）→ `DEFAULT_GATEWAY`。
 * 哪一级赢了、写坏了怎么报都在 core；home 可以传，测试要把配置文件指到临时目录。
 */
export function resolveGateway(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): ResolvedGateway {
  return resolveFacadeGateway({ envVarNames: GATEWAY_ENV_VARS, env, home });
}
