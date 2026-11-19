// opencode 这一侧的网关事实：地址从哪来、config hook 等多久。
// 环境变量名、配置文件路径与键名都是这套工具链的约定：core 的 resolveGateway 只收「候选 + 读取器」，不认名字。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGateway as pickGateway, type ResolvedGateway } from "../../core/gateway.ts";

/**
 * 这一侧的环境变量优先级，从高到低。`FACADE_GATEWAY` 是几个 agent 共用的名字：同一台机器上网关只有一个。
 */
export const GATEWAY_ENV_VARS = ["OPENCODE_FACADE_GATEWAY", "FACADE_GATEWAY"] as const;

/**
 * 每级都没配时试这个：`helper/README.md` 把 `http://127.0.0.1:6450` 写成默认地址。
 * 只试这一个、不做局域网扫描：config hook 在启动路径上被 await，猜错等于对着错的网关取清单。
 */
export const DEFAULT_GATEWAY = "http://127.0.0.1:6450";

/** 默认值也连不上时的提示：既说清怎么指别处，也说明这不是 fatal */
export const NO_GATEWAY_HINT =
  `no gateway configured and the default ${DEFAULT_GATEWAY} is unreachable: set OPENCODE_FACADE_GATEWAY, ` +
  "or FACADE_GATEWAY, " +
  'or write {"gateway": "http://gateway.example:6450"} to ~/.config/buddy-helper/config.json';

/**
 * config hook 里等网关的上限：opencode 在解析完配置后 await 每个插件的 config hook，这个数字等于
 * 「网关挂掉时 opencode 启动多等多久」。1500ms 与 pi 取同一个数（连接被拒立即返回，只有连得上不回话才吃满）。
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/** 配置文件的目录与文件名。和 pi 共用同一份：它是这套工具链的配置，不是某个 agent 的 */
const CONFIG_DIR = [".config", "buddy-helper"];
const CONFIG_FILE = "config.json";

/** 配置文件里的 gateway 字段。没有文件、文件坏了、没有这个键都当没有 */
export function readGatewayConfig(home: string = os.homedir()): string {
  const file = path.join(home, ...CONFIG_DIR, CONFIG_FILE);
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof data !== "object" || data === null) return "";
    const value = (data as Record<string, unknown>).gateway;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/**
 * OPENCODE_FACADE_GATEWAY → FACADE_GATEWAY → 配置文件 → `DEFAULT_GATEWAY`。
 * 环境变量与 home 可以传：测试要把配置文件指到临时目录。哪一级赢了、写错了怎么报都在 core。
 */
export function resolveGateway(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ResolvedGateway {
  return pickGateway({
    candidates: GATEWAY_ENV_VARS.map((name) => ({ from: name, value: env[name] ?? "" })),
    config: { label: "config file", read: () => readGatewayConfig(home) },
    fallback: DEFAULT_GATEWAY,
  });
}
