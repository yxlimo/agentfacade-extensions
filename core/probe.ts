// 探活：按模型发一条最小 chat 请求，把「能不能用」翻成分好的状态。
// 分类、并发、超时、去重都在这一层；agent 只接线与显示，不重新解释状态码。
// 探活不是派单闸门：这里的语义只覆盖已知的那几种失败，不能替代真实请求。

import { gatewayUrl, MODELS_DIALECT } from "./gateway.ts";

export type ProbeStatus =
  | "ok"
  | "quota"
  | "auth"
  | "missing"
  | "throttled"
  | "upstream"
  | "unreachable"
  | "timeout"
  | "cancelled"
  | "unclassified";

export interface ProbeResult {
  model: string;
  status: ProbeStatus;
  /** 拿到了响应才有；fetch 自己抛错时没有 */
  httpStatus?: number;
  /** 一行可读原因，从错误体里取并截断；成功时没有 */
  detail?: string;
  latencyMs: number;
}

export interface ProbeOptions {
  gateway: string;
  apiKey?: string;
  models: readonly string[];
  timeoutMs?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  /** 调用方取消（例如宿主的长命令被打断）；与内部超时取先到的一个 */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CONCURRENCY = 4;
const MAX_DETAIL_CHARS = 400;
// 分类只需要错误体里的一小段线索：先截到这个上限再压平/解析，免得几 MB 的正文被复制三份
const MAX_BODY_CHARS = 4096;
const CHAT_PATH = "/v1/chat/completions";

function positiveOr(value: number | undefined, fallback: number): number {
  // 非法值一律回落默认值：尤其 concurrency 不能留 0 —— 零 worker 会让 Promise.all([]) 静默返回空表
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export interface ProbePlan {
  readonly count: number;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly worstMs: number;
}

/** 兜底与最坏耗时都算在 core：宿主只负责把 count 与秒数印出来，不自己猜默认值 */
export function probePlan(
  modelCount: number,
  options: Pick<ProbeOptions, "timeoutMs" | "concurrency"> = {},
): ProbePlan {
  const timeoutMs = positiveOr(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  // concurrency 0 钳回默认值而不是 1：1 会把全量探活拉成串行，默认值才是设计里的节奏；关键是绝不留零 worker
  const concurrency = positiveOr(options.concurrency, DEFAULT_CONCURRENCY);
  const count = Number.isFinite(modelCount) && modelCount > 0 ? Math.trunc(modelCount) : 0;
  return { count, timeoutMs, concurrency, worstMs: Math.ceil(count / concurrency) * timeoutMs };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_CHARS ? value : `${value.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/** 错误体偶尔会回显请求头里的密钥：显示前再抹一次，别让排障输出变成泄露口 */
function redact(value: string, apiKey: string | undefined): string {
  return apiKey === undefined || apiKey === "" ? value : value.split(apiKey).join("***");
}

function firstString(values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return flat(value);
  }
  return "";
}

interface BodyInfo {
  /** 整个错误体的压平文本，用来认那些不在 message 字段里的关键词 */
  raw: string;
  message: string;
  upstream: string;
}

/** 错误体解析必须容错：非 JSON、空体、超长体都只是「没有可读原因」，不能再抛一次错 */
async function readBody(response: Response): Promise<BodyInfo> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    // body 读不动就按空体处理：分类还有状态码，不至于整条探活失败
  }
  // 几 MB 的错误体不会抛，但分类只需要开头那点线索：先截断再压平/解析，不留三份整份副本
  if (raw.length > MAX_BODY_CHARS) raw = raw.slice(0, MAX_BODY_CHARS);
  const text = flat(raw);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { raw: text, message: "", upstream: "" };
  }
  const root = asRecord(payload);
  const error = asRecord(root.error);
  // 上游原文有的一层挂在 error 下、有的直接挂在根上：两处都看，detail 才留得住原文
  const upstreamRaw = root.upstream ?? error.upstream;
  const upstream = asRecord(upstreamRaw);
  return {
    raw: text,
    message: firstString([error.message, root.message, root.error, root.detail]),
    upstream: firstString([upstream.message, upstream.body, upstream.error, upstream.response, root.upstream, error.upstream]),
  };
}

function allText(body: BodyInfo): string {
  return `${body.raw} ${body.message} ${body.upstream}`.toLowerCase();
}

function quotaWords(body: BodyInfo): boolean {
  const text = allText(body);
  return text.includes("exceed quota limit") || text.includes("quota exceeded") || text.includes("insufficient_quota");
}

/** 502 常被网关用来包上游的 400/403：错误体里找得到上游状态或它的原文才算 upstream（额度词已在 classify 先行拦走） */
function wrappedUpstream(body: BodyInfo): boolean {
  const text = allText(body);
  // 单独的 code/status 太通用（网关自己的 code:403 不算上游证据）：必须有 upstream/provider 同现才认
  if (/\b(?:upstream|provider)\b/.test(text)) {
    if (/(?:upstream|provider)[^0-9]{0,24}\b(?:400|403)\b/.test(text)) return true;
    if (/\b(?:400|403)\b[^0-9]{0,24}(?:upstream|provider)/.test(text)) return true;
    if (/(?:statuscode|status|code)[^0-9]{0,24}\b(?:400|403)\b/.test(text)) return true;
  }
  return false;
}

function classify(status: number, body: BodyInfo): ProbeStatus {
  if (status === 200) return "ok";
  if (status === 401 || status === 403) return "auth";
  // HTTP 402 就是 Payment Required，不看正文：词表只作其它状态的辅助，且让 401/403/404/429 的状态码判定先于词表
  if (status === 402) return "quota";
  if (status === 404) return "missing";
  if (status === 429) return "throttled";
  // 额度耗尽对应充值/换号、重试无用，上游故障或请求被上游拒绝才单列 upstream：两种状态的动作不同。
  // 网关常把额度错误包进 502，所以额度词先于 502 的上游标记判定——否则同一个额度语义会因用词落进两个状态
  if (quotaWords(body)) return "quota";
  if (status === 502 && wrappedUpstream(body)) return "upstream";
  return "unclassified";
}

function httpDetail(status: number, body: BodyInfo, apiKey: string | undefined): string {
  // 502 要留上游原文摘要，否则看到「Bad Gateway」还是不知道模型到底为什么不行
  const detail =
    status === 502 && body.upstream !== ""
      ? [body.message, body.upstream].filter((part) => part !== "").join(" | ")
      : body.message || body.raw || `HTTP ${status}`;
  return truncate(redact(detail, apiKey));
}

function thrownStatus(error: unknown, timedOut: boolean): ProbeStatus {
  if (timedOut || (error instanceof Error && error.name === "AbortError")) return "timeout";
  const cause = asRecord(error instanceof Error ? (error as { cause?: unknown }).cause : undefined);
  const code = typeof cause.code === "string" ? cause.code.toUpperCase() : "";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "EAI_AGAIN") {
    return "unreachable";
  }
  if (error instanceof TypeError) return "unreachable";
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|econnrefused|enotfound|getaddrinfo|network/i.test(message) ? "unreachable" : "unclassified";
}

function thrownDetail(error: unknown, timedOut: boolean, timeoutMs: number, apiKey: string | undefined): string {
  if (timedOut) return `timed out after ${timeoutMs}ms`;
  const message = error instanceof Error ? error.message : String(error);
  const cause = asRecord(error instanceof Error ? (error as { cause?: unknown }).cause : undefined);
  const causeMessage = typeof cause.message === "string" ? cause.message : "";
  const detail = causeMessage && causeMessage !== message ? `${message}: ${causeMessage}` : message;
  return truncate(redact(detail || "request failed", apiKey));
}

function cancelledResult(model: string, started: number): ProbeResult {
  // 调用方取消不是超时也不是模型的问题：单列状态，让宿主能如实说「已取消」
  return { model, status: "cancelled", detail: "cancelled by caller", latencyMs: Date.now() - started };
}

async function probeOne(
  model: string,
  url: string,
  options: ProbeOptions,
  timeoutMs: number,
  run: typeof fetch,
): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let resolveCancel: (() => void) | undefined;
  // 外层信号先到的一个算取消；即便 fetch 不理 signal，这条 promise 也能让本次探活立刻收尾
  const onCancel = new Promise<"cancelled">((resolve) => {
    resolveCancel = () => resolve("cancelled");
  });
  const onOuterAbort = () => {
    if (timedOut) return;
    cancelled = true;
    controller.abort();
    resolveCancel?.();
  };
  if (options.signal?.aborted) onOuterAbort();
  else options.signal?.addEventListener("abort", onOuterAbort);
  const timer = setTimeout(() => {
    if (cancelled) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (cancelled) return cancelledResult(model, started);
  try {
    const response = await Promise.race([run(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: controller.signal,
    }), onCancel]);
    // 外层取消先到：不读 body，也不把取消洗成任何 HTTP 状态
    if (response === "cancelled") return cancelledResult(model, started);
    // 假 fetch 可以不理 signal：定时器已经响了就按超时算，不让迟到的响应把它洗成 ok
    if (timedOut) {
      return { model, status: "timeout", detail: `timed out after ${timeoutMs}ms`, latencyMs: Date.now() - started };
    }
    if (cancelled) return cancelledResult(model, started);
    const body = await readBody(response);
    if (cancelled) return cancelledResult(model, started);
    return {
      model,
      status: classify(response.status, body),
      httpStatus: response.status,
      ...(response.status === 200 ? {} : { detail: httpDetail(response.status, body, options.apiKey) }),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    if (cancelled) return cancelledResult(model, started);
    return {
      model,
      status: thrownStatus(error, timedOut),
      detail: thrownDetail(error, timedOut, timeoutMs, options.apiKey),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** 一条模型独立成败；输出顺序与去重后的输入一致，在途请求数不超过 concurrency */
export async function probeModels(options: ProbeOptions): Promise<ProbeResult[]> {
  const unique = [...new Set(options.models)];
  const plan = probePlan(unique.length, options);
  if (plan.count === 0) return [];
  // 探活和目录一样显式锁方言：默认方言一改，分类会静默错，而请求照样 200
  const url = gatewayUrl(options.gateway, CHAT_PATH, `dialect=${MODELS_DIALECT}`);
  const run = options.fetchImpl ?? fetch;
  const results: ProbeResult[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(plan.concurrency, plan.count) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= unique.length) return;
      results[index] = await probeOne(unique[index], url, options, plan.timeoutMs, run);
    }
  });
  await Promise.all(workers);
  return results;
}
