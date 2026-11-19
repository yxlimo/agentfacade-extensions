// dsh 的设置写入层：能力探测（一次）、找 llm-pi-ai 的 ns、把 provider profile 写进去。
//
// 为什么整层按能力探测而不是看版本号：上游以 rc.N 高频迭代（docs/hosts-dsh.md 实测
// 0.2.1-rc.2 / 0.2.2-rc.1 / master 三版），版本号字符串随时变，接口形状却稳定。
// 三条分叉各有一条降级路径，每条单独命中：
//
//   · 写 API：mutate（只写命名路径，不必重述脱敏密钥）→ 没有就 replace/update
//     （整段提交，从脱敏后的快照重建会静默删掉密钥字段 —— 这是降级要付的代价）
//   · 并发保护：写 API 接受 expectedRevision → 没有就「读一次写一次」，冲突不可检测
//   · volatile 判定：宿主的 isVolatilePath 拒绝非 volatile 路径 → 没有就本插件自己按
//     llm-pi-ai 的 Config 形状校验（providers 在三个版本里都是 volatile，但旧版没有
//     那层检查，没人替我们拦坏配置）
//
// 探测结果由调用方缓存（index.ts 存在 state.capabilities 上），本层每次调用只读。

import { validateProviderProfile, type PiAiProviderProfile } from "./provider.ts";

/**
 * describe() 的一条。字段形状照 0.2.2-rc.1 的 dsh-settings.d.ts（vendor 在
 * docs/reference/dsh/api/）。这里不 import 那个包：它依赖 @deepseek-ai/cordis，
 * 本仓装不了。`revision` 可选 —— 老形态宿主可能不返回它（docs/hosts-dsh.md 的分叉表）。
 */
export interface SettingsDescriptor {
  ns: string;
  autoGenerate?: boolean;
  schema?: unknown;
  value?: unknown;
  revision?: number;
  applies?: "live";
  secrets?: unknown[];
}

/** docs/hosts-dsh.md 规定唯一的写入形态：命名路径的 set/unset */
export type SettingsPathOp =
  | { op: "set"; path: readonly string[]; value: unknown }
  | { op: "unset"; path: readonly string[] };

/**
 * dsh 的 settings 服务里本插件用到的那部分。
 *
 * `isVolatilePath` 是 mutate 的内部检查（vendor 的 d.ts 里没有签名，所以这里是
 * unknown 的宽松形状），存在与否本身就是能力信号。
 */
export interface SettingsHost {
  writable?: boolean;
  documentPath?: string;
  describe(opts?: { redactSecrets?: boolean }): SettingsDescriptor[];
  update?(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void>;
  replace?(ns: string, section: Record<string, unknown>, expectedRevision?: number): Promise<void>;
  mutate?(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
  isVolatilePath?(path: unknown): boolean;
}

/** 降级到哪条写 API；null 表示这版宿主一条都没有 */
export type WriteMode = "mutate" | "replace" | "update";

export interface Capabilities {
  /** 实际会用的写 API（mutate 优先；都没有时是占位，problems 里写明） */
  write: WriteMode;
  /**
   * 写 API 是否接受 expectedRevision。判定用函数 `length`（真实实现是可选第三参，
   * 不带默认值时 `length` 就是 3）。把 revision 写成默认值（`r = 0`）的实现会被判成
   * 没有 —— 那种实现本来也拿不到「本次读到的是哪个版本」。
   */
  revision: boolean;
  /** 宿主没有 isVolatilePath：本插件自己校验 provider 形状 */
  ownVolatileCheck: boolean;
  /** 写 API 是 replace/update：必须先合并旧 section（代价见文件头） */
  mergeSection: boolean;
  /** 无法写入的原因；空数组表示可以写 */
  problems: string[];
}

/**
 * 探测宿主能力。只做形状判定（typeof / 函数参数个数），不碰版本号。
 *
 * 传 undefined（宿主没有 settings 服务）时不抛，返回带 problems 的能力表：插件随后
 * 报错说明，且**不**退化成写文件 —— 那是红线。
 */
export function probeCapabilities(host: SettingsHost | undefined): Capabilities {
  if (!host || typeof host.describe !== "function") {
    return {
      write: "mutate",
      revision: false,
      ownVolatileCheck: true,
      mergeSection: true,
      problems: [
        "ctx.settings is unavailable or has no describe() — this dsh build cannot take a runtime provider config; " +
          "the agentfacade route will not be registered (this plugin never falls back to editing files)",
      ],
    };
  }

  const write: WriteMode | null =
    typeof host.mutate === "function" ? "mutate" : typeof host.replace === "function" ? "replace" : typeof host.update === "function" ? "update" : null;

  const problems: string[] = [];
  if (write === null) {
    problems.push(
      "ctx.settings exposes none of mutate/replace/update — no runtime write API on this dsh build; " +
        "refusing to fall back to cordis.patch.yml or settings.yaml",
    );
  }
  if (host.writable === false) {
    problems.push(`ctx.settings is not writable (profile patch: ${host.documentPath ?? "unknown"}) — the active profile rejects form edits`);
  }

  const writeFn = write === null ? undefined : host[write];
  return {
    write: write ?? "mutate",
    revision: write !== null && typeof writeFn === "function" && writeFn.length >= 3,
    ownVolatileCheck: typeof host.isVolatilePath !== "function",
    mergeSection: write !== null && write !== "mutate",
    problems,
  };
}

export type NamespacePick =
  | { ok: true; descriptor: SettingsDescriptor; matchedBy: "schema" | "value" }
  | { ok: false; error: string };

/**
 * 从 describe() 里找出 llm-pi-ai 那个条目的 ns。
 *
 * 不写死 id：它可能是 `llm-pi-ai`，也可能是 `@deepseek-ai/dsh-llm-pi-ai`。判定按
 * schema 里有没有 `providers` 这个键（docs/hosts-dsh.md 第 1 条）；宿主老形态不给
 * schema 时退一步看 value 里有没有 providers（「缺 schema 改用配置项白名单判定」）。
 */
export function pickNamespace(descriptors: readonly SettingsDescriptor[]): NamespacePick {
  const bySchema = descriptors.find((entry) => mentionsProviders(entry.schema));
  if (bySchema) return { ok: true, descriptor: bySchema, matchedBy: "schema" };

  const byValue = descriptors.find((entry) => hasOwn(entry.value, "providers"));
  if (byValue) return { ok: true, descriptor: byValue, matchedBy: "value" };

  const described = descriptors.map((entry) => JSON.stringify(entry.ns)).join(", ") || "(none)";
  return {
    ok: false,
    error:
      `cannot tell which settings entry holds the llm-pi-ai config: no descriptor schema or value mentions "providers" ` +
      `(described: ${described}). providers must live under the llm-pi-ai entry; nothing was written`,
  };
}

/** 重读一次某个 ns 的最新条目（冲突重试用）；读不到返回 null */
export function describeEntry(host: SettingsHost, ns: string): SettingsDescriptor | null {
  try {
    return host.describe().find((entry) => entry.ns === ns) ?? null;
  } catch {
    return null;
  }
}

export interface WriteOutcome {
  ok: boolean;
  /**
   * 实际走的分叉，写进状态与日志（docs/hosts-dsh.md：每条分叉都要留下选了哪条的痕迹）。
   * 形态：`mutate+revision` / `mutate` / `replace+revision` / `replace` / `update+revision` / `update`
   */
  path: string;
  ns: string;
  error?: string;
}

export interface WriteOptions {
  host: SettingsHost;
  caps: Capabilities;
  /** 写之前读到的条目（带 revision 与完整 section） */
  descriptor: SettingsDescriptor;
  providerName: string;
  value: PiAiProviderProfile;
}

/**
 * 把 provider profile 写进 llm-pi-ai 条目的 `providers.<route>`。
 *
 * 顺序：volatile/形状校验 → 按能力选写 API → 冲突重读重试一次。
 * 任何一步失败都返回 ok:false 并带一句人话；**绝不**在这里动文件。
 */
export async function writeProvider(options: WriteOptions): Promise<WriteOutcome> {
  const { host, caps, providerName, value } = options;
  let entry = options.descriptor;
  const target = ["providers", providerName];

  if (caps.ownVolatileCheck) {
    // 旧版没有 isVolatilePath：自己按 llm-pi-ai 的 Config 形状校验。校验不过就拒绝 ——
    // 写进去就是一份启动时炸的配置，还会把 providers 下别的路由一起带崩
    const invalid = validateProviderProfile(value);
    if (invalid !== null) {
      return { ok: false, path: caps.write, ns: entry.ns, error: `${invalid} — refusing to write providers.${providerName}` };
    }
  } else if (!isVolatile(host, target)) {
    return {
      ok: false,
      path: caps.write,
      ns: entry.ns,
      error: `dsh rejected providers.${providerName} as a non-volatile config path — refusing to write (never falls back to editing files)`,
    };
  }

  const write = caps.write;

  const submit = async (current: SettingsDescriptor): Promise<boolean> => {
    const revision = caps.revision && typeof current.revision === "number" ? current.revision : undefined;
    if (write === "mutate") {
      const ops: SettingsPathOp[] = [{ op: "set", path: target, value }];
      if (revision === undefined) await host.mutate!(current.ns, ops);
      else await host.mutate!(current.ns, ops, revision);
    } else {
      const section = mergedSection(current.value, providerName, value);
      const writeSection = write === "replace" ? host.replace! : host.update!;
      if (revision === undefined) await writeSection(current.ns, section);
      else await writeSection(current.ns, section, revision);
    }
    return revision !== undefined;
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const usedRevision = await submit(entry);
      return { ok: true, path: `${write}${usedRevision ? "+revision" : ""}`, ns: entry.ns };
    } catch (error) {
      if (!isConflict(error)) {
        return { ok: false, path: write, ns: entry.ns, error: `settings write failed: ${messageOf(error)}` };
      }
      // 没有 revision 参数就没有冲突可言（旧版读一次写一次）；真拿到 SETTINGS_CONFLICT
      // 说明宿主仍然做版本检查，重读一次再写是唯一能做的
      if (attempt >= 1) {
        return { ok: false, path: `${write}+revision`, ns: entry.ns, error: `SETTINGS_CONFLICT persisted after one retry: ${messageOf(error)}` };
      }
      // 重读一次：SETTINGS_CONFLICT 带着 actual，但值本身也可能变了，重读更稳。
      // 只重试一次 —— 循环重试会把并行写变成忙等
      const fresh = describeEntry(host, entry.ns);
      if (fresh === null) {
        return { ok: false, path: `${write}+revision`, ns: entry.ns, error: `${messageOf(error)} — re-describing did not find ${JSON.stringify(entry.ns)}` };
      }
      entry = fresh;
    }
  }
}

/**
 * replace/update 用的完整 section：旧值原样保留，只换 providers.<route> 这一格。
 *
 * 为什么必须先合并：replace 的重建来自脱敏文档，凭据字段（apiKeyEnv 之类）本来就不在
 * 里面；直接提交 { providers: {...} } 会把 section 里别的键（比如 agent-default-model
 * 的 provider/model）一起清掉。
 */
export function mergedSection(section: unknown, providerName: string, value: PiAiProviderProfile): Record<string, unknown> {
  const base = isPlainObject(section) ? { ...section } : {};
  const providers = isPlainObject(base.providers) ? { ...(base.providers as Record<string, unknown>) } : {};
  providers[providerName] = value;
  base.providers = providers;
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 私有 API 没有 vendor 的类型：`isVolatilePath` 究竟是收数组还是点路径没人保证。
 * 两种形状都问一次，谁认用谁 —— 都不认才当作「不是 volatile」拒绝。
 * 它抛异常时也按 false 处理：拿不到一个诚实的回答，就不写。
 */
function isVolatile(host: SettingsHost, path: readonly string[]): boolean {
  const check = host.isVolatilePath;
  if (typeof check !== "function") return true; // 形状校验兜底
  const ask = (arg: unknown): boolean => {
    try {
      return check.call(host, arg) === true;
    } catch {
      return false;
    }
  };
  return ask(path) || ask(path.join("."));
}

function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "SETTINGS_CONFLICT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** schema 里有没有 providers 键。序列化失败（循环引用的 zod 形态）就当没有，交给 value 兜底 */
function mentionsProviders(schema: unknown): boolean {
  if (schema === undefined || schema === null) return false;
  try {
    return JSON.stringify(schema)?.includes('"providers"') ?? false;
  } catch {
    return false;
  }
}

function hasOwn(node: unknown, key: string): boolean {
  return isPlainObject(node) && Object.prototype.hasOwnProperty.call(node, key);
}
