# agentfacade-extensions 设计（决定项，不是草稿）

一套逻辑，三个宿主（pi / opencode / deepseek harness）。目标是**核心抽象复用**，每个宿主只写
它真正特有的那部分。

## 一句话结构

```
网关 /v1/models ──core──> ModelSpec[] ──hosts/<宿主>──> 宿主原生配置 + 注册
```

`core` 不知道任何宿主的存在；`hosts/*` 不知道网关协议，只接收 `ModelSpec[]`。

## core（宿主中立，纯函数 + 一次 fetch）

| 模块 | 职责 | 不属于它的 |
| --- | --- | --- |
| `gateway.ts` | 地址解析（调用方按优先级传入候选列表）、`GET {gateway}/v1/models?dialect=openai`（**方言锁定**）、超时/取消、错误分类（连不上 / 超时 / 非 JSON / 空清单） | 任何宿主的环境变量名 |
| `catalog.ts` | openai 渲染的 payload → `ModelSpec[]`：字段归一化、缺省值（context 200000 / output 4096）、档位/模态/报价原样提取 | 宿主的字段名 |
| `sync.ts` | 状态机：`lastGood` 清单、`lastError`、是否已注册、空清单与失败时**退回上一次成功的清单**、刷新返回值语义 | 通知怎么显示 |
| `types.ts` | `ModelSpec` / `CatalogResult` / `HostAdapter` / `Notifier` | — |

## 唯一跨宿主契约

```ts
export interface ModelSpec {
  id: string;
  displayName: string;
  reasoning: boolean;        // 上游声明支持思考；未声明按 true（不知道不等于不支持）
  efforts: string[];         // 上游给的档位，**原样**（不排序/不改名/不去重/不补 off），不做宿主级映射
  contextWindow: number;
  maxOutputTokens: number;
  toolCall: boolean | null;  // `null` 是「网关没说」，不是「不能」，也不是「支持」
  modalities: {              // `null` 是「网关没说」；`input: []` 是网关断言「一个都不收」
    input: string[];
    output: string[];
  } | null;
  /**
   * 报价，**每百万 token、美元**（网关就是这么报的，core 不缩放、不换算币种）。
   * 键可缺：只报了输出价时 `inputPerMillion` 不出现 —— **缺键是「没报价」，0 是「报价为零」**，
   * 两者不能互相顶替。一个键都没有 / 没有 cost 整层 → `cost` 为 null。
   */
  cost: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheReadPerMillion?: number;
  } | null;
}

export interface HostAdapter<Provider = unknown, Registered = unknown> {
  readonly id: string;                                            // "pi" | "opencode" | "dsh"
  readonly gatewayEnvVars: readonly string[];                     // 该宿主自己的环境变量优先级
  toProvider(specs: readonly ModelSpec[], opts: AdapterOptions): Provider;
  register(provider: Provider, ctx: RegisterContext): Promise<Registered> | Registered;
}
```

## 报文方言：锁定 openai

网关同一份目录有多种渲染（字段名与层级各不相同），由 `?dialect=` 或请求头选择 —— **默认值在网关那边**。
core 在 URL 上写死 `dialect=openai`，只解析这一种：默认值一变就整体读空，而且不报错、只静默拿到一堆
缺省值。地址自带 query 时用 `&` 接，不能拼出第二个 `?`（第二个 `?` 之后的参数网关不看）。

字段映射（openai 渲染 → `ModelSpec`），**缺失或类型不对一律当「没说」，不抛异常**：

| 报文 | `ModelSpec` | 「没说」时 |
| --- | --- | --- |
| `id` | `id` | 非字符串 / 空 → 丢掉这一项 |
| `name` | `displayName` | 回落 `id` |
| `capabilities.reasoning.supported` | `reasoning` | `true`（不知道不等于不支持） |
| `capabilities.reasoning.effort` | `efforts` | `[]`（不补 `off`、不排序、不改拼写） |
| `limit.context` | `contextWindow` | `200000`（`0` 也算没说） |
| `limit.output` | `maxOutputTokens` | `4096`（`0` 也算没说） |
| `capabilities.tools.supported` | `toolCall` | `null` |
| `modalities.{input,output}` | `modalities` | `null`（只有一侧是字符串数组 → 也 `null`） |
| `cost.text.input.price` | `cost.inputPerMillion` | 该键不出现 |
| `cost.text.input.cache.read` | `cost.cacheReadPerMillion` | 该键不出现 |
| `cost.text.output.price` | `cost.outputPerMillion` | 该键不出现；三键全无 → `cost: null` |

价格单位是**每百万 token、美元**：网关侧不缩放，core 也不缩放、不换算币种。网关只报它知道的字段
（0 也可能是真实报价 —— 免费模型就是 0 元），所以「字段不在」= 网关没说，不是 0。

报文形状只有一个样本：`core/test/fixtures/gateway-openai.json`。用例从它取一条再改单格，
不各自重抄整份 payload（重抄的那份迟早和网关的真实形状分叉，而重抄的用例照样绿）。

## 归属规则（谁写在哪，别混）

- **档位（efforts）原样保留在 core 输出里**。pi 有固定 5 档，需要「往下取、不往上取」的收敛 ——
  那是 pi 的阶梯，写在 `hosts/pi`；opencode 原样用；dsh 按它的 provider 约定。
- **缺省值属于 core**（context 200000 / output 4096 是网关的约定，不是某个客户端的）。
- **「没说」与「零值」的区别属于 core，不许在宿主里被抹平**：`toolCall: null`（网关没说）≠
  `false`（网关说不能）；`cost` 缺 `inputPerMillion` 键（没报输入价）≠ `inputPerMillion: 0`（免费）；
  `modalities: null`（没报）≠ `{ input: [], output: [] }`（报了「一个都不收」）。
  宿主各自决定「不知道」时怎么填，但 core 交出去的那一层必须保住这个区别。
- **报价的换算属于宿主**：core 交的是网关的原始数字（每百万 token、美元），
  `hosts/pi` 要的 `{input, output, cacheRead, cacheWrite}` 是它的注册形状，写在 `hosts/pi`；
  别的宿主可能只要一个总价。core 不替任何人缩放或换算币种。
- **`compat` 属于 `hosts/pi`**：那是 pi 注册路径特有的要求，别的宿主没有这回事。
- **命令与提示文案属于 hosts**（`/facade-models` 是 pi 的叫法）。

## 生效方式：不写用户配置文件

三个宿主都不许偷偷改用户配置文件：

- pi：`registerProvider()` 运行时注册（已有）。
- opencode：插件 `config` hook 在解析后注入 provider（不改 `opencode.jsonc`）。
- dsh：插件在 cordis provider 上声明（不改 `cordis.patch.yml`）。

宿主若没有运行时注入能力，就**报错说明**，不要退化成写文件。

## 测试契约

- `core`：纯函数 + 一次 fetch，用例不起网络（注入 fetch）。
- 每个 `hosts/*`：假宿主 API，断言**注入的配置对象逐字**（快照式），并断言失败路径（网关不可达
  / 空清单 / 非 JSON）不注册。
- 比例要求：core 用例覆盖归一化与状态机；宿主用例覆盖映射与「绝不注册空清单」。
- 网关报文的形状**只有一份**，在 `core/test/fixtures/gateway-openai.json`。宿主测试直接构造
  `ModelSpec[]`，不重抄报文：宿主的职责是「ModelSpec → 宿主配置」，它不该知道网关长什么样。
  重抄的那份迟早和网关真实形状分叉，而且分叉之后用例照样绿。
- `scripts/check-boundary.ts` 把这个规矩变成会红的检查：扫三个宿主的**生产源码**，出现网关协议
  词汇（`display_name` / `context_window` / `capabilities.*` / `limit.*` …）或写文件 API 就失败。
  只扫代码不扫注释 —— 注释里解释网关字段名是宿主作者需要的，把它写进代码去取值才是越界。
  这条检查在 `pnpm test` 里，不在任何单个宿主的套件里：它管的是层与层之间的边界，属于全仓。

## 迁移约束（给要实现的人）

`hosts/pi` 是现有实现搬进来的，**映射断言不许改**：80 条用例必须保持绿，只允许把
`gateway.ts` / `catalog.ts` 的那部分实现换成 core 调用。若发现现有用例断言的是宿主特有字段
（`cost`/`compat`/`thinkingLevelMap`），那些断言留在 `hosts/pi`，不许下沉到 core。

## 非目标

- 不做网关侧的账号/会话管理。
- 不做模型能力探测（只读网关声明的字段）。
- 不发版、不装进用户的 `~/.pi`、`~/.config/opencode`、dsh 家目录 —— 安装是用户的事。
