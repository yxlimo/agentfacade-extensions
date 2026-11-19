# opencode 宿主适配器（**v2 插件 API**）

把 AgentFacade 网关的模型清单变成 opencode 的 provider，**在运行时注入**，不碰用户的配置文件。

```text
网关 /v1/models ──core──> ModelSpec[] ──这里──> ctx.provider.transform(e => e.add({ info, models }))
```

`core` 只交出 `ModelSpec[]`；这一层只做两件事：把它翻成 v2 的 `Provider.Info` + `Model.Info`
（`v2.ts`），以及把翻译好的对象交给 opencode 的注册面（`index.ts`）。

## 为什么是 v2 形状

v1 的插件是「default 导出一个函数，函数返回 hooks」，其中 `config` hook 收到 opencode **解析后的
配置对象**，插件就地往里写 `providers.<id>`。v2 不是这样：它要求 default 导出
`{ id, setup(ctx) }`，provider 通过 `ctx.provider.transform(editor => editor.add(payload))` 注册。
把 v1 形状配到 v2.2.7 上直接加载失败：

```text
Plugin must export a default definition with an id and an effect or setup function
```

所以这不是「改个名字」，是照 v2 的注册面重写的。v1 时代的 `toOpencodeProvider` / `injectProvider` /
`OpencodeInjection` / `OpencodeConfigLike` 已从 `catalog.ts` 删掉；那份「按 id 合并用户手写模型」
的规则也一起没了 —— v2 注册的是**独立 provider**，不去动别人那一格，不需要合并。

## 安装（v2）

`opencode.jsonc` 里注册插件。键名是 **`plugins`**（复数，数组；v1 的 `plugin` 不认），条目是
npm 包名或**本地目录的绝对路径**。指向本目录：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/extensions/agentfacade-extensions/hosts/opencode"]
}
```

（`plugins` 这个键与「数组里可以放 npm 包名」有实测依据：`~/.config/opencode/opencode.jsonc`
那份真实配置里就是 `"plugins": ["@cortexkit/opencode-magic-context@latest"]`。）

本地插件写的是**目录**，不是文件：写成 `.ts` 路径会直接报错

```text
configured plugin path must be a directory
```

**装不装是用户的事**：本仓不发版、不替用户安装，也不写 `~/.config/opencode/**`。

`@opencode/plugin` 是 opencode 运行时提供的包，本仓没有这个依赖。我们要交出去的东西全是纯数据
（brand 只在类型层），所以 `index.ts` 自己声明了用到的两格（`OpencodeV2Context` / `OpencodeV2Editor`），
少一个依赖、也少一层版本耦合。

## `package` 用哪个：实测结论

`package` 决定 opencode 拿哪套方言去请求 `settings.baseURL`。这个字段不能按名字推断，只能试：

| package | 结果 |
| --- | --- |
| `@ai-sdk/anthropic`（v1 用户配置里的写法） | **失败**：`Provider package @ai-sdk/anthropic does not export model(modelID, settings)` —— v2 要求 package 是导出 `model(modelID, settings)` 的模块，v1 的 AI SDK 包不是 |
| `@opencode/ai/providers/anthropic`（默认，`DEFAULT_PACKAGE`） | **可用**：真机 `opencode run --model agentfacade/coder-a` 回了 `PONG`（baseURL 带 `/v1`，与网关主路由的 anthropic 方言一致） |
| `@opencode/ai/providers/openai-compatible` | **未实测**，留作可配置项（`pkg` 选项） |

换包就是换方言：换之前先验一次真实请求，别只看「provider 出现在列表里」。

## 字段映射

| v2 | 网关 |
| --- | --- |
| `info.id` | 固定 `agentfacade`（模型引用写成 `agentfacade/<modelID>`，独立名字，不与用户已有的 provider 撞名） |
| `info.name` | `AgentFacade (main route)`，与 pi 那一侧一致 |
| `info.activation` | 固定 `"enabled"`（不写就是 `auto` 的语义） |
| `info.package` | `DEFAULT_PACKAGE`，见上一节 |
| `info.settings.baseURL` | 网关根地址 + `/v1`（末尾斜杠在这里归一，`...//v1` 会把请求打歪） |
| `info.settings.apiKey` | 固定 `public`（网关跑 public 模式时不校验） |
| `models[].id` / `.modelID` | 同一个 `id`（v2 用这两格拼模型引用） |
| `models[].providerID` | `agentfacade` |
| `models[].name` | `displayName`（core 归一过：网关没给名字时它退回 `id`）。**必须覆盖**：`Model.Info.default()` 给的是裸 id，不改的话选择器里全是 `coder-a` 这种机器名 |
| `models[].limit.context` / `.output` | `contextWindow` / `maxOutputTokens`（缺省 200000 / 4096 由 core 补） |
| `models[].capabilities.tools` | `toolCall`。网关说不能就 `false`；**没说（`null`）按支持** —— 与 pi 的缺省一致，不知道不等于不能（这是宿主的选择） |
| `models[].capabilities.input` / `.output` | `modalities` 有就用它（连 `input: []`「一个都不收」也照它的来）；网关没报（`null`）才退回录制里的常量 `["text","image"]` / `["text"]` —— 退回的是录制里的事实，不是推断 |
| `models[].variants` | 恒 `[]`，见「已知缺口」 |
| `models[].status` / `.enabled` / `.time` / `.cost` | `"active"` / `true` / `{released: 0}` / `[]` |

期望值在 `fixtures/expected.ts` 里是**手写快照**（由 `test/check.ts` 里那份 `SNAPSHOT_SPECS`——
6 条显式 `ModelSpec`——人工推导）。改映射必须同时改它 —— 两边一起动是刻意的，否则「映射改了
但测试还绿」。

## 已知缺口：档位（reasoning efforts）目前不表达

v1 的模型定义里有 `capabilities.reasoning.{supported, effort}`，**v2 没有这一格**。v2 的可选变体挂在
`variants`（钩子里是 `model.variant`），但条目形状文档没给、运行时默认是空数组。

所以：**上游的档位信息在 opencode 这一侧暂时丢失**。`ModelSpec.efforts` 一路传到 `toV2Model` 门口
就停住，`variants` 恒为空数组 —— 不发明形状，`editor.add()` 收到的对象必须是 opencode 认得的。

补法（等事实，不等猜测）：把 `variants` 的形状实测出来之后，在 `toV2Model` 里按 `spec.efforts` 填；
换形状就只改那一处，测试里那份快照会同时要求改。

## 生效方式：运行时注入，不写文件

`setup(ctx)` 里拉一次清单 → `ctx.provider.transform(editor => editor.add(payload))`。**不写任何文件**：
`~/.config/opencode/opencode.jsonc`、`models.jsonc` 一个字节都不动。写文件是「谁跑过谁才更新」，
而网关的模型清单是活的（面板上改一下主路由就变了）；而且用户的配置该由用户自己改。
`test/check.ts` 最后一段会扫一遍本目录的源码，出现任何写文件的 API 就变红 —— 这是机制，不是自觉。

## 拉不到时：不注册

**绝不注册空清单。** 一个 provider 的模型表是整表，注册空表等于把用户手上能用的模型清空 —— 比
「列表过期」糟得多。下面这些都只留一行 `[facade-models]` 开头的警告（写 stderr：opencode 的插件
没有 console 面板），**不调用 `add`**，用户原有配置继续生效：

- 网关不可达 / 超时
- HTTP 非 2xx
- 答的不是 JSON 对象，或没有 `data` 数组
- `data` 是空数组（网关起来了但上游路由还没加载）
- 地址写错（不是 http(s)）—— 一次请求都不发，直接点名是哪个变量写错了
- 拉到了清单但映射不出模型（core 那边按「zero usable models」处理）

启动时网关不可达也不要紧：网关起来之后重开 opencode，`setup` 会再跑一遍。文案按事实说话 ——
没有「已经注册过」这种记忆（opencode 重载插件会重新 `setup`），所以只说「这次没有注册」。

## 网关地址从哪来

| 优先级 | 来源 |
| --- | --- |
| 1 | `OPENCODE_FACADE_GATEWAY` |
| 2 | `FACADE_GATEWAY`（几个宿主共用：一台机器上只有一个网关） |
| 3 | `~/.config/buddy-helper/config.json` 的 `gateway` 字段（这套工具链的配置，pi 那一侧也读它） |
| 4 | `http://127.0.0.1:6450`（网关一般跑在本机） |

只试这一个地址，不做局域网扫描：扫描要花时间且没把握，而 `setup` 在 opencode 的启动路径上被
`await` —— 猜错（本机还是局域网那份）等于对着错的网关取清单。

环境变量名、配置文件路径、默认地址、超时预算都在 `gateway-config.ts`：它们是 opencode 这一侧的
事实，core 只接收排好序的候选与一个「读配置」的函数。

## 超时

默认 1500ms（`DEFAULT_TIMEOUT_MS`）。这个数字直接等于「网关挂掉时 opencode 启动多等多久」：
连接被拒是立即返回的，只有「连得上但不回话」才吃满。core 的默认 5 秒是给「不在启动路径上」的
调用方的，这里必须自己传。

## 测

```bash
node --experimental-strip-types hosts/opencode/test/check.ts       # 95 条断言
node node_modules/typescript/bin/tsc --noEmit -p hosts/opencode/tsconfig.json
```

全部离线：网络用**注入的 fetch** 伪造（`fetchOptions.fetchImpl`，不起端口、不连真网关），配置文件
用临时主目录，`ctx` 用假对象（`provider.transform` 捕获 callback，`editor.add` 记录入参）。覆盖：

- `toV2Model` / `toV2Payload` 的逐字快照（含「name 必须是 displayName」与「variants 恒为空数组」）
- `setup` 成功路径：`add` 调一次、payload 逐字、只打一次 `/v1/models`
- 每一类失败路径（不可达 / 空清单 / 非 JSON / HTTP 500 / 地址写错 / 默认地址连不上）
  **一次都不调 `add`**，且 stderr 上真的有一行警告
- 超时预算确实传下去了（默认 1500ms，`timeoutMs` 可覆盖）—— 漏传就会吃 core 的 5 秒
- 空清单不替换上一次的清单（core 的状态机，从这一侧也钉一遍）
- 地址优先级、`pkg` / `displayName` 选项
- 「源码里没有写文件的 API / 没有网关协议词汇」两条扫描

期望值分两处：`test/check.ts` 里的 `SNAPSHOT_SPECS`（**6 条显式 `ModelSpec`**，宿主的输入面）
与 `fixtures/expected.ts`（手写快照）。**这里没有网关报文的拷贝** —— 条目字段长什么样是 core 的
事，形状只留一份（在 core 的测试里）。注册路径那几条用例只需要「拉到了 N 条」，所以假网关只回
`{ data: [{ id }] }`：条目其余字段由 core 归一，不在这里重复声明。
