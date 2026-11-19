// opencode 这一侧的网关事实：地址从哪来（候选顺序、共用的配置文件、默认地址）、config hook 等多久。
//
// 为什么这些留在 opencode 而不是 core：`OPENCODE_FACADE_GATEWAY` 这个名字、`~/.config/buddy-helper/`
// 这个路径、`{"gateway": …}` 这个键名都是这套工具链的约定，别的宿主没有这一套。core 的
// resolveGateway 只接收「候选 + 读取器」，不认任何名字 —— 认名字就等于 core 知道了宿主。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGateway as pickGateway, type ResolvedGateway } from "../../core/gateway.ts";

/**
 * 这一侧自己的环境变量优先级，从高到低。HostAdapter.gatewayEnvVars 直接用它 ——
 * 名字是宿主的，core 只按顺序拿候选。
 *
 * 第二级 `FACADE_GATEWAY` 是几个宿主共用的名字：同一台机器上网关只有一个，
 * 用户设一次就该三个宿主都认。
 */
export const GATEWAY_ENV_VARS = ["OPENCODE_FACADE_GATEWAY", "FACADE_GATEWAY"] as const;

/**
 * 每级都没配时试这个。不是猜的：网关通常就跑在本机，`helper/README.md` 把
 * `http://127.0.0.1:6450` 写成默认地址（pi 那份 README 记了实测：本机与局域网指同一份清单）。
 *
 * 只试这一个，不做局域网扫描：config hook 在启动路径上被 await，拿启动延迟换一次没把握的
 * 发现不划算；猜错（本机还是局域网那份）等于对着错的网关取清单，报出来的东西没意义。
 */
export const DEFAULT_GATEWAY = "http://127.0.0.1:6450";

/** 默认值也连不上时的提示：既说清怎么指别处，也说明这不是 fatal */
export const NO_GATEWAY_HINT =
  `no gateway configured and the default ${DEFAULT_GATEWAY} is unreachable: set OPENCODE_FACADE_GATEWAY, ` +
  "or FACADE_GATEWAY, " +
  'or write {"gateway": "http://gateway.example:6450"} to ~/.config/buddy-helper/config.json';

/**
 * config hook 里等网关的上限。
 *
 * opencode 在解析完配置之后 await 每个插件的 config hook，所以这个数字直接等于「网关挂掉时
 * opencode 启动多等多久」。1500ms 与 pi 那一侧取同一个数（同一套启动预算的实测结论：
 * 连接被拒是立即返回的，只有「连得上但不回话」才吃满）。
 *
 * core 的默认值是 5 秒（通用库不该假定调用方在启动路径上）；这个数必须由宿主自己传。
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/** 配置文件的目录与文件名。和 pi 共用同一份：它是这套工具链的配置，不是某个宿主的 */
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
 * 这次要用的网关地址：OPENCODE_FACADE_GATEWAY → FACADE_GATEWAY → 配置文件 → `DEFAULT_GATEWAY`。
 *
 * 环境变量与 home 可以传：测试要把配置文件指到临时目录，不能读真实主目录。
 * 「哪一级赢了」「写错了怎么报」全在 core 里，这里只负责把 opencode 的优先级摆出来。
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
