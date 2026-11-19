// core 与宿主之间唯一的契约。
//
// 这个文件里不许出现任何宿主的词汇：只要某个名字只在某一个宿主里有意义
// （宿主的档位表、只有某条注册路径才需要的字段、宿主自己的环境变量名、宿主的命令名），
// 它就不属于这里 —— 属于那个宿主的目录。守这条线的方式不是自觉，是
// core/test/check.ts 里那份禁用词扫描。

/** 网关一个模型在跨宿主视角下的样子。宿主各自把它翻成自己的配置形状 */
export interface ModelSpec {
  id: string;
  displayName: string;
  /** 上游声明支持思考；**未声明按 true** —— 不知道不等于不支持 */
  reasoning: boolean;
  /**
   * 上游给的档位，**原样**：不排序、不改名、不补值、不去重。
   *
   * 「档位怎么收敛到本宿主的阶梯」是宿主的事（有的宿主只往下取，有的原样用），
   * 一旦在这里替宿主排好序或补一档，core 就把某个宿主的阶梯变成了所有宿主的假设。
   */
  efforts: string[];
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * 网关声明能不能调工具；`null` 是「没人说」，不是「不能」。
   *
   * 与 `reasoning` 不同：思考没声明按「支持」处理（缺省开），工具调用没声明就是不知道 ——
   * 宿主各自决定「不知道」时怎么办，core 不替它猜。
   */
  toolCall: boolean | null;
  /**
   * 模态，`null` 是网关没报。空数组与缺省要分开：`input: []` 是「一个模态都不收」，
   * 那是网关的断言，不是我们该替它填的。
   */
  modalities: { input: string[]; output: string[] } | null;
  /**
   * 价格，**每百万 token、美元**（网关就是这么报的，core 不缩放、不换算币种）。
   *
   * 字段可缺：只报输出价时输入那侧不出现 —— 0 元与没报价是两件事，不能互相顶替。
   * 宿主把它翻成自己的形状（pi 要 `{input, output, cacheRead, cacheWrite}`，别的宿主可能
   * 只要一个总价），但「哪一侧没报价」这一事实必须传到宿主，不许在 core 里被 0 抹平。
   */
  cost: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheReadPerMillion?: number;
  } | null;
}

/**
 * 一次目录拉取的结果。
 *
 * 空清单不算成功：`{ ok: true, specs: [] }` 会让调用方以为「网关上一个模型都没有」，
 * 而真实情况常常是网关起来了但上游路由还没加载。两种情况要能分开，所以空清单走 error。
 */
export type CatalogResult =
  | { ok: true; specs: ModelSpec[] }
  | { ok: false; cancelled: boolean; error: string };

/** 宿主给用户看警告的通道。core 只说「这次算不算失败」，文案与显示方式是宿主的事 */
export interface Notifier {
  warn(message: string): void;
}

/** 宿主把 ModelSpec 翻成自己配置时需要的地址与凭据 */
export interface AdapterOptions {
  /** 网关根地址，**不带 /v1**（拼路径是宿主的事） */
  baseUrl: string;
  apiKey: string;
}

/** register() 收到的东西：宿主的扩展 API + 通知通道。core 不解读宿主 API */
export interface RegisterContext<Host = unknown> {
  host: Host;
  notifier: Notifier;
}

/**
 * 一个宿主适配器的最小形状。每个宿主都实现这套方法，core 只规定它长什么样、不调用它
 * （宿主自己把 core 的产物交给自己宿主的注册路径）。
 */
export interface HostAdapter<Provider = unknown, Registered = unknown> {
  readonly id: string;
  /**
   * 该宿主自己的环境变量优先级，从高到低。core 不认这些名字，只按顺序拿它们当候选 ——
   * 认名字就等于 core 知道了宿主。
   */
  readonly gatewayEnvVars: readonly string[];
  toProvider(specs: readonly ModelSpec[], opts: AdapterOptions): Provider;
  register(provider: Provider, ctx: RegisterContext): Promise<Registered> | Registered;
}
