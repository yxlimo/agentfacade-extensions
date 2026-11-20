// /agentfacade probe 的接线：整理参数、取此刻的地址与密钥、调 core、把结果排成表。
// 状态码怎么解释是 core/probe.ts 的事；这里没有 if (status === …)，也不回显密钥。

import { resolveHostAuthKey } from "../../core/auth.ts";
import { probeModels, probePlan, type ProbeResult } from "../../core/probe.ts";
import { resolveGateway } from "./gateway-config.ts";
import type { PluginOptions, PluginState } from "./index.ts";

/** 末尾那句必须一直在：探活是参考，不是派单闸门 */
export const PROBE_DISCLAIMER =
  "探活结果仅供参考，不是派单闸门：探活失败不等于用不了，成功也不保证这一次请求能成";

/** 表 + 失败原因 + 提示，整段逐字可断言；延迟是实测值，断言时按 /\d+ms/ 归一 */
export function renderProbe(results: readonly ProbeResult[]): string[] {
  const lines = ["模型 | 状态 | HTTP | 延迟"];
  for (const result of results) {
    lines.push(`${result.model} | ${result.status} | ${result.httpStatus ?? "-"} | ${result.latencyMs}ms`);
  }
  for (const result of results) {
    if (result.detail !== undefined) lines.push(`${result.model}: ${result.detail}`);
  }
  lines.push(PROBE_DISCLAIMER);
  return lines;
}

/** 探活问的是「此刻连哪、用什么钥匙」：重新解析，不用启动时缓存的 state 字段 */
function target(options: PluginOptions): { gateway: string; apiKey?: string } | { error: string } {
  const resolved = resolveGateway(options.env ?? process.env, options.home);
  if (!resolved.ok) return { error: `probe: ${resolved.error} — 地址没解析出来，什么都没探` };
  const { key } = resolveHostAuthKey({
    prefix: "PI",
    env: options.env ?? process.env,
    home: options.home,
    warn: options.warn,
  });
  return key === "" ? { gateway: resolved.gateway } : { gateway: resolved.gateway, apiKey: key };
}

/** 不给模型名就探当前已注册的那批；解析与分类都不在这里做 */
export interface ProbeInvocation {
  /** 宿主给的取消信号；能拿到就传，拿不到就不传 */
  signal?: AbortSignal;
  /** 长命令开始前先报一句进度，避免「卡住」的错觉 */
  notify?: (message: string) => void;
}

export async function runProbe(
  args: string,
  state: PluginState,
  options: PluginOptions,
  invocation: ProbeInvocation = {},
): Promise<string[]> {
  const names = args.trim().split(/\s+/).filter((part) => part !== "");
  // core 探活会去重，进度里的 N 用同一口径：别报「探活 3 条」却只发出 2 条请求
  const models = [...new Set(names.length > 0 ? names : state.models.map((model) => model.id))];
  if (models.length === 0) return ["没有模型可探：先 /agentfacade refresh，或给出模型名"];
  const chosen = target(options);
  if ("error" in chosen) return [chosen.error];
  const plan = probePlan(models.length, options.probe);
  // 先报进度再 await：默认全量探活最坏几十秒，事后才 notify 等于让用户对着空白等待
  invocation.notify?.(`探活 ${plan.count} 条模型，最坏约 ${Math.ceil(plan.worstMs / 1000)} 秒`);
  const results = await probeModels({
    gateway: chosen.gateway,
    ...(chosen.apiKey === undefined ? {} : { apiKey: chosen.apiKey }),
    models,
    ...options.probe,
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  });
  return renderProbe(results);
}
