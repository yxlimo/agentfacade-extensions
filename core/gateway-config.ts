// 网关地址从哪来：三个 agent 共用的解析链与配置文件都在这一层。
// host 只传自己的环境变量名；「连到哪台网关」是全机一个事实，所以配置文件只有一份，
// 由 core 读写 —— 见 docs/design.md「网关地址从哪来」与 README「连到网关」。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { isHttpUrl, resolveGateway, type GatewayCandidate, type GatewayConfigRead, type GatewayConfigSource, type ResolvedGateway } from "./gateway.ts";

/** host 传比环境变量更高的候选时要造这个形状，再导出省得各处绕回 gateway.ts */
export type { GatewayCandidate } from "./gateway.ts";

/** 每级都没配时试这个：README 与 docs/design.md 写的默认地址 */
export const DEFAULT_GATEWAY = "http://127.0.0.1:6450";

/** connect 归一化时 http 缺省补的端口；https 不补 —— 443 是它自己的默认 */
export const DEFAULT_HTTP_PORT = 6450;

/** 我们自己的配置文件（唯一允许写的文件）与旧名（只读，兼容） */
const CONFIG_SEGMENTS = [".config", "agentfacade", "config.json"];
const LEGACY_SEGMENTS = [".config", "buddy-helper", "config.json"];

/** 报错与 connect 显示里怎么称呼这两级 */
const CONFIG_LABEL = "config file";
const LEGACY_LABEL = "legacy config file";

function fileAt(home: string, segments: readonly string[]): string {
  return path.join(home, ...segments);
}

// ── 归一化（connect 子命令的输入） ────────────────────────────────────────

export type NormalizeResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * connect 的地址归一化：trim；没有 scheme 补 `http://`；scheme 是 http 且没写端口补 `:6450`
 * （https 不补）；末尾斜杠去掉。非 http(s) 或解析失败 → 返回错误，绝不猜测。
 *
 * 端口判定不用 URL 的 port 字段：`http://x:80` 的 80 是 http 的默认端口，URL 会把它吞掉，
 * 于是「用户显式写了 :80」和「没写端口」在 URL 里长得一样 —— 按后者补 :6450 就是静默改地址。
 */
export function normalizeGatewayInput(input: string): NormalizeResult {
  const raw = input.trim();
  if (raw === "") return { ok: false, error: "gateway address is empty" };
  const withScheme = raw.includes("://") ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `not a URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `only http(s) is supported: ${raw}` };
  }
  const rest = withScheme.slice(withScheme.indexOf("://") + 3);
  const authority = rest.split(/[/?#]/)[0];
  // authority 原样保留（大小写、userinfo、IPv6 括号都不动）：display_name 不是这里的职责
  const wrotePort = /:\d+$/.test(authority);
  const missingPort = url.port === "" && !wrotePort;
  const portSuffix = missingPort && url.protocol === "http:" ? `:${DEFAULT_HTTP_PORT}` : "";
  const tail = rest.slice(authority.length).replace(/\/+$/, "");
  return { ok: true, url: `${url.protocol}//${authority}${portSuffix}${tail}` };
}

// ── 配置文件：读 ──────────────────────────────────────────────────────────

/** 读自己的 config.json。没有文件 → {value:""}（没配）；JSON 坏 / gateway 类型不对 → 带原因的失败 */
function readConfigAt(home: string, segments: readonly string[], display: string): GatewayConfigRead {
  const file = fileAt(home, segments);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // 读不到按没配处理：ENOENT 是常态（用户还没 connect 过）；无权读之类也归到这里
    return { value: "" };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { error: `${display} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { error: `${display} must be a JSON object like {"gateway": "<url>"}, got ${JSON.stringify(data)}` };
  }
  const gateway = (data as Record<string, unknown>).gateway;
  if (typeof gateway !== "string" || gateway.trim() === "") {
    return { error: `${display} has no non-empty string "gateway" field, got ${JSON.stringify(gateway)}` };
  }
  return { value: gateway };
}

/** ~/.config/agentfacade/config.json —— 三个 agent 共用的那一级 */
function readFacadeConfig(home: string): GatewayConfigRead {
  return readConfigAt(home, CONFIG_SEGMENTS, "~/.config/agentfacade/config.json");
}

/**
 * 旧路径 ~/.config/buddy-helper/config.json（兼容）。坏文件按没配处理，不按错误报：
 * 那份文件的历史行为就是「坏了当没有」，升到报错会让老用户莫名其妙多一条错。
 * 但里面写了一个坏地址仍会报错 —— 地址是显式的配置，坏文件不是。
 */
function readLegacyConfig(home: string): GatewayConfigRead {
  const file = fileAt(home, LEGACY_SEGMENTS);
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const gateway = typeof data === "object" && data !== null ? (data as Record<string, unknown>).gateway : undefined;
    return typeof gateway === "string" ? { value: gateway } : { value: "" };
  } catch {
    return { value: "" };
  }
}

// ── 配置文件：写（connect 用） ────────────────────────────────────────────

export type WriteResult = { ok: true; file: string } | { ok: false; error: string };

/**
 * 原子写 ~/.config/agentfacade/config.json：临时文件（0600）+ rename。
 * rename 失败时把临时文件清掉，不留垃圾；目录不存在就建。
 */
export function writeFacadeConfig(home: string, gateway: string): WriteResult {
  if (!isHttpUrl(gateway)) {
    return { ok: false, error: `refusing to write a non-http(s) gateway: ${gateway}` };
  }
  const file = fileAt(home, CONFIG_SEGMENTS);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 0600 写在临时文件上，rename 原地替换：目标文件从头到尾要么是旧内容要么是新内容
    fs.writeFileSync(tmp, `${JSON.stringify({ gateway }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能还没建出来：清理失败不算第二条错误
    }
    return { ok: false, error: `cannot write ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── 共用解析链 ────────────────────────────────────────────────────────────

export interface FacadeGatewayOptions {
  /** agent 自己的环境变量名，从高到低；共用的那个名字也由调用方排在最后 —— 环境变量名留在 agent 那侧 */
  readonly envVarNames: readonly string[];
  /** 环境变量来源；缺省 process.env */
  env?: NodeJS.ProcessEnv;
  /** 配置文件根（~ 的位置）。测试注入临时目录；缺省真实 home */
  home?: string;
  /** 比环境变量更高的候选（如 dsh 的插件配置） */
  extraCandidates?: readonly GatewayCandidate[];
}

/**
 * `<agent 的环境变量们>` → `~/.config/agentfacade/config.json` → `~/.config/buddy-helper/config.json`
 * → 默认地址。哪一级赢了、写错了怎么报都在这里；显式写错的地址报错，不悄悄退回默认值。
 */
export function resolveFacadeGateway(options: FacadeGatewayOptions): ResolvedGateway {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const envCandidates: readonly GatewayCandidate[] = options.envVarNames.map((name) => ({
    from: name,
    value: env[name] ?? "",
  }));
  const sources: readonly GatewayConfigSource[] = [
    { label: CONFIG_LABEL, read: () => readFacadeConfig(home) },
    { label: LEGACY_LABEL, read: () => readLegacyConfig(home) },
  ];
  return resolveGateway({
    candidates: [...(options.extraCandidates ?? []), ...envCandidates],
    config: sources,
    fallback: DEFAULT_GATEWAY,
  });
}
