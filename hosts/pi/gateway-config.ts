// pi 这一侧的网关事实：地址从哪来（候选顺序、配置文件位置、默认地址）、启动时等多久。
//
// 为什么这些留在 pi 而不是 core：`PI_FACADE_GATEWAY` 这个名字、`~/.config/buddy-helper/`
// 这个路径、`{"gateway": …}` 这个键名都是这套工具链的约定，别的宿主没有这一套。
// core 的 resolveGateway 只接收「候选 + 读取器」，不认任何名字。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGateway as pickGateway, type ResolvedGateway } from "../../core/gateway.ts";

/**
 * 每级都没配时试这个。不是猜的：`helper/README.md` 把 `http://127.0.0.1:6450`
 * 写成默认地址（网关通常就跑在本机）。实测本机 127.0.0.1:6450 与局域网那份地址
 * 返回同一份 17 条清单。
 *
 * 只试这一个，不做局域网扫描：扫描要花时间、结果不确定，而 pi 的扩展工厂在启动
 * 路径上被 await —— 拿启动延迟换一次没把握的发现不划算。用户要指别处，写配置文件
 * （配置文件里的 `gateway` 字段就是它）或设环境变量。
 */
export const DEFAULT_GATEWAY = "http://127.0.0.1:6450";

/** 默认值也连不上时的提示：既说清怎么指别处，也说明这不是 fatal */
export const NO_GATEWAY_HINT =
  `no gateway configured and the default ${DEFAULT_GATEWAY} is unreachable: set PI_FACADE_GATEWAY, ` +
  'or FACADE_GATEWAY, or write {"gateway": "http://gateway.example:6450"} ' +
  "to ~/.config/buddy-helper/config.json";

/**
 * 启动时等网关的上限。pi 的扩展工厂是 async，它在启动路径上被 await，
 * 所以这个数字直接等于「网关挂掉时 pi 多等多久」。1500ms 留了 500ms 余量给
 * 请求本身以外的开销（实测见 README），保证不可达时不超过 2 秒。
 *
 * core 的默认值是 5 秒（通用库不该假定调用方在启动路径上）；这个数必须由 pi 自己传。
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/** 配置文件路径与键名 */
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
 * 这次要用的网关地址：PI_FACADE_GATEWAY → FACADE_GATEWAY → 配置文件 → `DEFAULT_GATEWAY`。
 *
 * 环境变量与 home 可以传：测试要把配置文件指到临时目录，不能读真实主目录。
 * 「哪一级赢了」「写错了怎么报」全在 core 里，这里只负责把 pi 的优先级摆出来。
 */
export function resolveGateway(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ResolvedGateway {
  return pickGateway({
    candidates: [
      { from: "PI_FACADE_GATEWAY", value: env.PI_FACADE_GATEWAY ?? "" },
      { from: "FACADE_GATEWAY", value: env.FACADE_GATEWAY ?? "" },
    ],
    config: { label: "config file", read: () => readGatewayConfig(home) },
    fallback: DEFAULT_GATEWAY,
  });
}
