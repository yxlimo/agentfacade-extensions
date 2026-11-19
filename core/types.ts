// core 与 agent 之间唯一的契约。
// 这里不许出现任何 agent 的词汇：只有某个 agent 才懂的名字属于那个 agent 的目录（core/test/check.ts 扫这条线）。

export interface ModelSpec {
  id: string;
  displayName: string;
  /** 没声明不等于不支持，缺省 true */
  reasoning: boolean;
  /** 网关给的原样：不排序、不改名、不补值、不去重。收敛到 agent 的阶梯是 agent 的事 */
  efforts: string[];
  contextWindow: number;
  maxOutputTokens: number;
  /** `null` 是「没人说」不是「不能」：agent 各自决定怎么办，core 不替它猜 */
  toolCall: boolean | null;
  /** `null` 是没报；`input: []` 是「一个都不收」，两者不能互相顶替 */
  modalities: { input: string[]; output: string[] } | null;
  /** 每百万 token、美元；缺键是「没报价」，0 是免费 —— 补 0 会把没说变成免费 */
  cost: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheReadPerMillion?: number;
  } | null;
}

/** 空清单不算成功：走 error，调用方才知道要保持原状 */
export type CatalogResult =
  | { ok: true; specs: ModelSpec[] }
  | { ok: false; cancelled: boolean; error: string };

/** agent 给用户看警告的通道：文案与显示方式是 agent 的事 */
export interface Notifier {
  warn(message: string): void;
}

/** agent 把 ModelSpec 翻成自己配置时需要的地址与凭据 */
export interface AdapterOptions {
  /** 网关根地址，**不带 /v1**（拼路径是 agent 的事） */
  baseUrl: string;
  apiKey: string;
}

/** register() 收到的东西：agent 的扩展 API + 通知通道。core 不解读 agent API */
export interface RegisterContext<Host = unknown> {
  host: Host;
  notifier: Notifier;
}

/** agent 适配器的最小形状：core 只规定它长什么样，不调用它 */
export interface HostAdapter<Provider = unknown, Registered = unknown> {
  readonly id: string;
  /** 该 agent 自己的环境变量名，从高到低；core 只按顺序当候选，不认名字 */
  readonly gatewayEnvVars: readonly string[];
  toProvider(specs: readonly ModelSpec[], opts: AdapterOptions): Provider;
  register(provider: Provider, ctx: RegisterContext): Promise<Registered> | Registered;
}
