// 网关地址从哪来、/v1/models 怎么拉 —— core 里唯一的网络与「地址」概念都在这一层。
// 这里不认任何环境变量名、不读配置文件：候选与读取器由调用方给，这一层只按顺序挑第一个能用的 http(s) 地址。

import { modelsFromPayload } from "./catalog.ts";
import type { CatalogResult } from "./types.ts";

/** 调用方没给超时时的默认值；启动路径上被 await 的调用方必须自己传更小的数 */
export const DEFAULT_TIMEOUT_MS = 5000;

/** 一级地址来源。`from` 是调用方起的名字，会原样进 ResolvedGateway 并显示给用户 */
export interface GatewayCandidate {
  readonly from: string;
  /** 原始值；空白与末尾斜杠由 core 清理，空串表示这一级没配 */
  readonly value: string;
}

/** 候选都没配时问它。core 只拿到「读」，不拿到路径 —— 配置文件属于宿主/工具链 */
export interface GatewayConfigSource {
  /** 报错与来源里怎么称呼它 */
  readonly label: string;
  /** 读出来的地址；空串表示没配（没有文件、文件坏了、没有这个键都算没配） */
  read(): string;
}

export interface ResolveGatewayOptions {
  /** 按优先级从高到低 */
  readonly candidates: readonly GatewayCandidate[];
  readonly config?: GatewayConfigSource;
  /** 哪里都没配时用的地址（调用方的默认值） */
  readonly fallback: string;
}

export type ResolvedGateway =
  | { ok: true; gateway: string; from: string }
  | { ok: false; error: string };

/** 末尾斜杠一律去掉：后面统一拼 `/v1/models` */
function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

/** 只认 http(s)：写错的地址（少了 scheme、写成 file://）在这里就报出来 */
function usable(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 候选（调用方给的顺序）→ 配置文件 → 调用方的默认值。
 * 前两级写错了就报错，不悄悄换成下一级 —— 拿默认值顶上去的人会以为配置生效了。
 */
export function resolveGateway(options: ResolveGatewayOptions): ResolvedGateway {
  for (const candidate of options.candidates) {
    const value = clean(candidate.value);
    if (!value) continue;
    return usable(value)
      ? { ok: true, gateway: value, from: candidate.from }
      : { ok: false, error: `${candidate.from} is not an http(s) URL: ${value}` };
  }
  const configured = options.config ? clean(options.config.read()) : "";
  if (configured) {
    const label = options.config?.label ?? "config";
    return usable(configured)
      ? { ok: true, gateway: configured, from: label }
      : { ok: false, error: `${label} gateway is not an http(s) URL: ${configured}` };
  }
  return { ok: true, gateway: clean(options.fallback), from: "default" };
}

/** 锁定报文方言：默认值在网关那边，随手一改就整体错位且不报错 */
export const MODELS_DIALECT = "openai";

/** 网关的模型清单地址：根路径下的 /v1/models，方言锁在 query 上 */
export function modelsUrl(gateway: string): string {
  // 地址自带 query 时用 & 接上：拼出第二个 "?" 会让它之后的参数被网关忽略，方言就静默失效了
  const cut = gateway.indexOf("?");
  const base = cut === -1 ? gateway : gateway.slice(0, cut);
  const query = cut === -1 ? "" : gateway.slice(cut + 1);
  const path = `${base}/v1/models`;
  return query ? `${path}?${query}&dialect=${MODELS_DIALECT}` : `${path}?dialect=${MODELS_DIALECT}`;
}

export type ModelListResult =
  | { ok: true; data: unknown[] }
  /** 调用方自己取消了这次刷新，不是网关的问题，不该当成失败报给人看 */
  | { ok: false; cancelled: boolean; error: string };

export interface FetchOptions {
  timeoutMs?: number;
  /** 调用方的取消信号；与超时取先到的一个 */
  signal?: AbortSignal;
  /** 注入 fetch，测试靠它制造永不响应、非 JSON 的上游 */
  fetchImpl?: typeof fetch;
}

/** 拉原始清单。任何失败都只是 error，不抛：调用方常在启动路径上等它 */
export async function fetchModelList(gateway: string, options: FetchOptions = {}): Promise<ModelListResult> {
  const url = modelsUrl(gateway);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.fetchImpl ?? fetch;

  // 传进来的 signal 可能已经 abort 了：已 abort 的 signal 不再触发 abort 事件，光加监听器会眼看着请求照发
  if (options.signal?.aborted) return { ok: false, cancelled: true, error: `${url} cancelled` };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort);

  // 超时可能发生在拿到响应头之后（读 body 时），所以错误文案统一先看 timedOut
  const fail = (message: string): ModelListResult =>
    timedOut
      ? { ok: false, cancelled: false, error: `${url} timed out after ${timeoutMs}ms` }
      : { ok: false, cancelled: false, error: message };

  try {
    const response = await run(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return fail(`${url} answered HTTP ${response.status}`);
    const payload: unknown = await response.json().catch(() => undefined);
    if (typeof payload !== "object" || payload === null) return fail(`${url} did not answer a JSON object`);
    const data = (payload as Record<string, unknown>).data;
    // data 不是数组按失败处理而不是按空清单：两者都不注册，但警告的含义不同
    if (!Array.isArray(data)) return fail(`${url} has no "data" list`);
    return { ok: true, data };
  } catch (error) {
    if (timedOut) return fail(`${url} timed out after ${timeoutMs}ms`);
    if (options.signal?.aborted) return { ok: false, cancelled: true, error: `${url} cancelled` };
    return fail(`${url} unreachable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** 拉一份能直接用的目录：空清单判成失败 —— 拿 0 条去替换等于把用户的模型清空 */
export async function fetchCatalog(gateway: string, options: FetchOptions = {}): Promise<CatalogResult> {
  const listed = await fetchModelList(gateway, options);
  if (!listed.ok) return listed;
  const specs = modelsFromPayload(listed.data);
  if (specs.length === 0) {
    return { ok: false, cancelled: false, error: `${modelsUrl(gateway)} listed no models` };
  }
  return { ok: true, specs };
}
