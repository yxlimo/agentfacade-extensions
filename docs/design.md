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
| `gateway.ts` | 地址解析（调用方按优先级传入候选列表）、`GET {gateway}/v1/models`、超时/取消、错误分类（连不上 / 超时 / 非 JSON / 空清单） | 任何宿主的环境变量名 |
| `catalog.ts` | 原始 payload → `ModelSpec[]`：字段归一化、缺省值（context 200000 / output 4096）、档位原样提取 | 宿主的字段名 |
| `sync.ts` | 状态机：`lastGood` 清单、`lastError`、是否已注册、空清单与失败时**退回上一次成功的清单**、刷新返回值语义 | 通知怎么显示 |
| `types.ts` | `ModelSpec` / `CatalogResult` / `HostAdapter` / `Notifier` | — |

## 唯一跨宿主契约

```ts
export interface ModelSpec {
  id: string;
  displayName: string;
  reasoning: boolean;        // 上游声明支持思考；未声明按 true（不知道不等于不支持）
  efforts: string[];         // 上游给的档位，**原样**，不做宿主级映射
  contextWindow: number;
  maxOutputTokens: number;
}

export interface HostAdapter<Provider = unknown, Registered = unknown> {
  readonly id: string;                                            // "pi" | "opencode" | "dsh"
  readonly gatewayEnvVars: readonly string[];                     // 该宿主自己的环境变量优先级
  toProvider(specs: readonly ModelSpec[], opts: AdapterOptions): Provider;
  register(provider: Provider, ctx: RegisterContext): Promise<Registered> | Registered;
}
```

## 归属规则（谁写在哪，别混）

- **档位（efforts）原样保留在 core 输出里**。pi 有固定 5 档，需要「往下取、不往上取」的收敛 ——
  那是 pi 的阶梯，写在 `hosts/pi`；opencode 原样用；dsh 按它的 provider 约定。
- **缺省值属于 core**（context 200000 / output 4096 是网关的约定，不是某个客户端的）。
- **`cost` / `compat` 属于 `hosts/pi`**：那是 pi 注册路径特有的要求，别的宿主没有这回事。
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

## 迁移约束（给要实现的人）

`hosts/pi` 是现有实现搬进来的，**映射断言不许改**：80 条用例必须保持绿，只允许把
`gateway.ts` / `catalog.ts` 的那部分实现换成 core 调用。若发现现有用例断言的是宿主特有字段
（`cost`/`compat`/`thinkingLevelMap`），那些断言留在 `hosts/pi`，不许下沉到 core。

## 非目标

- 不做网关侧的账号/会话管理。
- 不做模型能力探测（只读网关声明的字段）。
- 不发版、不装进用户的 `~/.pi`、`~/.config/opencode`、dsh 家目录 —— 安装是用户的事。
