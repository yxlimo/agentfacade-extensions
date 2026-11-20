// 密钥怎么落盘、从哪来：这一层只有密钥，没有 agent。
// 落盘学 pi 的 auth.json：{ "<provider>": { "type": "api_key", "key": "<secret>" } }，权限 0600。
// 文件是我们自己的（~/.config/agentfacade/auth.json，config.json 旁边），可以原子写；
// agent 的凭据文件（~/.pi/agent/auth.json 等）永远只读不写。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { WriteResult } from "./gateway-config.ts";

/** 我们自己的密钥文件；写入与 config.json 同一套手法（临时文件 0600 + rename） */
const AUTH_SEGMENTS = [".config", "agentfacade", "auth.json"];

/** 报错与来源里怎么称呼它 */
const AUTH_LABEL = "~/.config/agentfacade/auth.json";

/** auth.json 里我们自己的项名：provider 名就是目录名，别处不许再抄这个字面量 */
const OWN_ENTRY = "agentfacade"; // auth.json 的 key，形状学 pi 的 auth.json

export type AuthKeyRead = { value: string } | { error: string };

/**
 * 读 auth.json 里我们自己的那一项。
 * 文件不存在 / 没有 agentfacade 项 → 没有密钥（不是错误，`value: ""`）；
 * JSON 坏 / 形状不对 → 带原因的失败。显式写下的东西坏了要报出来，吞掉等于装作没配，
 * 用户会在「明明存了 key 却不带 Authorization」里绕很久。
 */
export function readAuthKeyAt(home: string): AuthKeyRead {
  const file = path.join(home, ...AUTH_SEGMENTS);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // ENOENT 是常态（还没存过密钥）；无权读之类也归到「没有」—— 密钥文件读不动不该挡住模型同步
    return { value: "" };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { error: `${AUTH_LABEL} is not valid JSON: ${messageOf(error)}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { error: `${AUTH_LABEL} must be a JSON object like {"agentfacade": {"type": "api_key", "key": "..."}}, got ${JSON.stringify(data)}` };
  }
  const entry = (data as Record<string, unknown>)[OWN_ENTRY];
  if (entry === undefined) return { value: "" };
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { error: `${AUTH_LABEL} entry "agentfacade" must be an object like {"type": "api_key", "key": "..."}, got ${JSON.stringify(entry)}` };
  }
  const record = entry as Record<string, unknown>;
  if (record.type !== "api_key") {
    return { error: `${AUTH_LABEL} entry "agentfacade" has type ${JSON.stringify(record.type)}, only "api_key" is supported` };
  }
  if (typeof record.key !== "string" || record.key === "") {
    return { error: `${AUTH_LABEL} entry "agentfacade" has no non-empty string "key" field, got ${JSON.stringify(record.key)}` };
  }
  return { value: record.key };
}

/**
 * 原子写密钥：临时文件（0600）+ rename，rename 失败清掉临时文件不留垃圾 —— 与 writeFacadeConfig
 * 同一手法，理由也一样：密钥文件从头到尾要么是旧内容要么是新内容，绝不留半截明文。
 */
export function writeAuthKeyAt(home: string, key: string): WriteResult {
  if (key.trim() === "") {
    return { ok: false, error: "refusing to write an empty API key" };
  }
  const file = path.join(home, ...AUTH_SEGMENTS);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ [OWN_ENTRY]: { type: "api_key", key } }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能还没建出来：清理失败不算第二条错误
    }
    return { ok: false, error: `cannot write ${file}: ${messageOf(error)}` };
  }
}

/** 解析结果。`key: ""` 是「没有密钥」（网关 public 模式），不是失败；error 只留给坏文件 */
export type AuthKey =
  | { ok: true; key: string; from: string }
  | { ok: false; error: string };

export interface ResolveAuthKeyOptions {
  /** host 自己的环境变量名，从高到低；共用的名字也由调用方排在最后 —— 环境变量名留在 agent 那侧 */
  readonly envVarNames: readonly string[];
  /** 环境变量来源；缺省 process.env */
  env?: NodeJS.ProcessEnv;
  /** 配置文件根（~ 的位置）。测试注入临时目录；缺省真实 home */
  home?: string;
}

/**
 * `<AGENT>_FACADE_API_KEY` → `FACADE_API_KEY` → auth.json → 默认没有。
 * 与网关地址同一套分层哲学：环境变量名是 agent 的事实，文件是全机一份、core 读写。
 */
export function resolveAuthKey(options: ResolveAuthKeyOptions): AuthKey {
  const env = options.env ?? process.env;
  for (const name of options.envVarNames) {
    const value = (env[name] ?? "").trim();
    if (value !== "") return { ok: true, key: value, from: name };
  }
  const home = options.home ?? os.homedir();
  const read = readAuthKeyAt(home);
  if ("error" in read) return { ok: false, error: read.error };
  if (read.value === "") return { ok: true, key: "", from: "none" };
  return { ok: true, key: read.value, from: AUTH_LABEL };
}

/** `<PREFIX>_FACADE_API_KEY` → `FACADE_API_KEY`：环境变量名的拼法只有这一处 */
export function authEnvNames(prefix: string): string[] {
  return [`${prefix}_FACADE_API_KEY`, "FACADE_API_KEY"];
}

export interface ResolveHostAuthKeyOptions {
  /** agent 的前缀（`PI` / `DSH` / `OPENCODE`） */
  readonly prefix: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 坏 auth.json 只报告、不中断：密钥坏了不该连带模型同步一起停 */
  warn?: (message: string) => void;
}

/** 三个 agent 共用的一条：环境变量 → auth.json → 没有；坏文件降级成空密钥并报告 */
export function resolveHostAuthKey(options: ResolveHostAuthKeyOptions): { key: string; from: string } {
  const resolved = resolveAuthKey({
    envVarNames: authEnvNames(options.prefix),
    env: options.env,
    home: options.home,
  });
  if (!resolved.ok) {
    options.warn?.(`ignoring the stored api key: ${resolved.error}`);
    return { key: "", from: "error" };
  }
  return { key: resolved.key, from: resolved.from };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
