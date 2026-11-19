# agentfacade-extensions

把 AgentFacade 网关的模型目录同步进各个 agent 宿主：一份 core，三个宿主适配器（pi、OpenCode、DeepSeek Harness）。

插件在自己的宿主启动时拉一次网关的 `GET /v1/models`，映射成该宿主自己的 provider 配置，在运行时注册进去。宿主需要刷新目录时再拉一次。

## 结构

```text
网关 /v1/models ──> core ──> ModelSpec[] ──> hosts/<宿主> ──> 宿主的运行时注册 API
```

- `core/`：网关地址解析、拉取与超时、字段归一化、「拉不到时怎么办」的状态机。纯函数 + 一次 fetch，不认任何宿主。
- `hosts/<宿主>/`：把 `ModelSpec[]` 翻成该宿主的配置形状并注册。字段名、档位阶梯、方言、命令文案都在这一层。

**不写任何用户配置文件**：注册全部走宿主自己的运行时 API。

## 宿主

| 宿主 | 接入点 | provider 名 |
| --- | --- | --- |
| pi | `pi.registerProvider`（扩展 `pi.extensions` 入口） | `agentfacade` |
| OpenCode | v2 插件 `ctx.provider.transform(editor.add)` | `agentfacade` |
| DeepSeek Harness | cordis 插件，`ctx.settings` 写入 `llm-pi-ai` 的 `providers.<route>` | `agentfacade` |

### pi

入口是 `hosts/pi/index.ts`，`package.json` 的 `pi.extensions` 指向它。

```bash
# 单次加载（验证用，不写入任何配置）
pi -e <仓库>/hosts/pi --list-models

# 常驻：放进 pi 的扩展目录
ln -s <仓库>/hosts/pi ~/.pi/agent/extensions/pi-agentfacade
```

提供两个命令：

```text
/facade-models          当前注册了几条模型、来自哪个网关、最后一次刷新时间
/facade-models refresh  立刻重拉一次并替换已注册的清单
```

### OpenCode

在 `opencode.jsonc` 的 `plugins` 数组里加本目录的**绝对路径**（键名是复数 `plugins`）：

```jsonc
{
  "plugins": ["<仓库>/hosts/opencode"]
}
```

条目必须是**目录**，写成 `.ts` 文件路径会报 `configured plugin path must be a directory`。

### DeepSeek Harness

cordis 插件，`apply(ctx, config)` 在宿主启动路径上被 await。provider 不落到文件：通过 `ctx.settings.mutate()` 写进 `llm-pi-ai` 的 `providers.<route>`，等价于在设置页保存一次。宿主没有可用的写入 API 时报错说明原因，不退化成写文件。

当前 `ModelSpec` 里 `toolCall` / `modalities` / `cost` 三项在 dsh 的 profile 形状里没有对应字段，因此不在该宿主表达。

## 网关地址

逐级解析，第一个非空的 http(s) 地址生效：

| 宿主 | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| pi | `PI_FACADE_GATEWAY` | `FACADE_GATEWAY` | `~/.config/buddy-helper/config.json` 的 `gateway` | `http://127.0.0.1:6450` |
| OpenCode | `OPENCODE_FACADE_GATEWAY` | `FACADE_GATEWAY` | 同上 | `http://127.0.0.1:6450` |
| DeepSeek Harness | `config.gateway` | `DSH_FACADE_GATEWAY` | `FACADE_GATEWAY` | `http://127.0.0.1:6450` |

配置文件只认一个键：

```json
{ "gateway": "http://gateway.example:6450" }
```

前几级写成非 http(s) 时**直接报错，不退回默认值**：写错地址的人需要知道写错了，用默认地址顶上去只会让人以为配置生效。

## 拉不到时

一律**不注册**，宿主原有的配置继续生效，只留一行警告。三种情况都算失败，且都不会替换已注册的清单：

- 网关不可达或超时
- 返回空清单（`data: []`）
- 返回的不是 JSON 对象，或 `data` 不是数组

**绝不注册空清单**：pi 的 legacy `models` 与 OpenCode 的 provider 模型表都是整表替换语义，注册空表会把用户手上能用的模型清空。

超时：pi 与 OpenCode 默认 1500 ms，DeepSeek Harness 2000 ms。宿主启动路径会 await 这次拉取，所以这个数字等于「网关挂掉时宿主多等多久」。

## 字段映射

`ModelSpec` 由 core 从网关报文归一化而来，三处语义必须分清：`null` 是「网关没说」，`false` 是「不支持」，`0` 是「报价为零」。

| ModelSpec | 网关来源 | pi | OpenCode | dsh |
| --- | --- | --- | --- | --- |
| `id` | `id` | `models[].id` | `models[].id` / `modelID` | `models[].id` |
| `displayName` | `name`（缺则回落 `id`） | `models[].name` | `models[].name` | `models[].name` |
| `reasoning` | `capabilities.reasoning.supported`（缺则 `true`） | `models[].reasoning` | — | — |
| `efforts` | `capabilities.reasoning.effort`（原样） | `thinkingLevelMap` | 不表达 | `reasoningEfforts` |
| `contextWindow` | `limit.context`（缺则 200000） | `models[].contextWindow` | `limit.context` | `models[].contextWindow` |
| `maxOutputTokens` | `limit.output`（缺则 4096） | `models[].maxTokens` | `limit.output` | `models[].maxTokens` |
| `toolCall` | `capabilities.tools.supported` | 固定 `["text","image"]` 输入 | `capabilities.tools` | 不表达 |
| `modalities` | `modalities` | 同上 | `capabilities.input/output` | 不表达 |
| `cost` | `cost.text.*`（每百万 token、美元） | `models[].cost` 四格 | `cost: []` | 不表达 |

每个宿主的映射规则就是那一层自己的约定，期望值写在该宿主的测试里；改映射要同时改期望值。

## 开发

```bash
pnpm install
pnpm test        # core 75 + pi 85 + opencode 95 + dsh 137 + 边界检查
pnpm typecheck
```

四套用例都不起真实网关：核心用例注入 fetch，宿主用例起本地假上游。设计决定与各宿主的实测事实见 [docs/design.md](docs/design.md)。
