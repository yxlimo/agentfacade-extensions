# 设计决定与实测事实

AgentFacade 的配套插件：一份 core，加各 agent 的适配器（目前接了 pi、OpenCode、DeepSeek Harness），把网关配置的模型同步进各 agent 的 provider。本文记录**为什么这样做**，以及**在真实 agent 上量到的事实**；行为与用法见 [README](../README.md)。

## 各 agent 共同的约定

这几条不分 agent。改任何一条，所有适配器都要跟着改，否则「同一个插件」就名不副实。

- **不写 agent 的配置文件。** 注册只走 agent 自己的运行时 API。`models.json`、`opencode.jsonc`、`cordis.patch.yml` 都是用户的家产，写它们等于绕过 agent 的校验与备份。唯一的例外是我们自己那份 `~/.config/agentfacade/config.json`，见「网关地址从哪来」。
- **拉不到就不注册，而不是注册成空。** 不可达、超时、空清单、非 JSON——一律保持原状，用户原有的模型继续可用，只留一行警告。注册空表的后果见「状态机」。
- **provider 名独立。** 各 agent 都用 `agentfacade`，与用户已有的 provider（`buddy` 之类）各走各的，不覆盖，也不需要改名共存。

## 分层与归属线

```text
网关 /v1/models ──> core ──> ModelSpec[] ──> hosts/<agent> ──> agent 的运行时注册 API
```

- `core/` **不认识任何 agent**：没有 agent 的字段名、档位阶梯、环境变量名、命令文案。它做的是网关的约定——字段怎么取、缺省值是多少、`null` 与 `0` 怎么分、拉不到时怎么办。
- `hosts/<agent>/` **不认识网关报文**：它只接收 `ModelSpec[]`。报文长什么样是 core 的事。

两条线都由扫描强制，不靠自觉：

- `core/test/check.ts` 扫 `core/` 的源文件，出现 agent 词汇即失败。
- `scripts/check-boundary.ts` 扫各适配器的**生产源码**，出现网关协议词汇（`display_name`、`context_window`、`capabilities.*`、`limit.*`、`dialect=` …）或写文件 API 即失败。只扫代码不扫注释——注释里解释网关字段名是适配器作者需要的。

为什么值得用扫描守：网关报文形状一度在各适配器的测试里各存一份，网关换渲染时每个适配器都得改；现在报文形状只有一份，在 `core/test/fixtures/gateway-openai.json`。

## ModelSpec 契约

单一跨 agent 契约，`core/types.ts`：

```ts
interface ModelSpec {
  id: string;
  displayName: string;
  reasoning: boolean;
  efforts: string[];
  contextWindow: number;
  maxOutputTokens: number;
  toolCall: boolean | null;
  modalities: { input: string[]; output: string[] } | null;
  cost: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheReadPerMillion?: number;
  } | null;
}
```

三条语义必须分开，混了就会替网关下结论：

| 值 | 含义 | 例子 |
| --- | --- | --- |
| `null` | 网关没说 | `toolCall: null` 不是「不能调工具」 |
| `false` | 网关明确说不支持 | `capabilities.tools.supported: false` |
| `0` | 明确的零 | `price: 0` 是免费，不是「没报价」 |

具体后果：

- `reasoning` 缺省为 `true`（不知道不等于不支持）；`toolCall` 缺省为 `null`（不替 agent 猜）。
- `efforts` 原样保留：不排序、不改名、不去重、不补 `off`。网关真会发 `midium` 这种拼写。
- `modalities` 只有两侧都是字符串数组才取；一侧缺失是 `null`，不是 `[]`——`input: []` 是「一个模态都不收」，替网关填等于我们宣布一个不存在的限制。
- `cost` 三个键各自独立：只报输出价时输入那侧不出现。补 0 会把「没说」变成「免费」。
- 缺省值 `contextWindow: 200000`、`maxOutputTokens: 4096` 在 core，因为那是**网关**的约定，各 agent 应给出同样的窗口。

## 报文方言：锁定 openai

网关同一份目录有不止一种渲染，由 `?dialect=` 或请求头决定，**默认值在网关那边**。core 在 URL 上显式写 `?dialect=openai`，不依赖网关默认值：默认值一改，解析的字段名整体错位，而且不报错、只静默拿到一堆缺省值。

请求地址自带 query 时必须用 `&` 接在已有参数后面。拼出第二个 `?` 会让它之后的参数被网关忽略——方言静默失效，而请求照样返回 200。

字段对照：

| openai 渲染 | 含义 |
| --- | --- |
| `name` | 展示名（缺失回落 `id`） |
| `limit.context` / `limit.output` | 窗口 / 输出上限 |
| `capabilities.reasoning.supported` / `.effort` | 是否支持思考 / 档位 |
| `capabilities.tools.supported` | 是否可调工具 |
| `modalities` | `{ input: [...], output: [...] }` |
| `cost.text.input.price` / `.cache.read` / `.text.output.price` | 每百万 token 的美元价 |

## 网关地址从哪来

每个 agent 的解析顺序，前面优先：

```text
<agent 自己的环境变量> → FACADE_GATEWAY → ~/.config/agentfacade/config.json
  → ~/.config/buddy-helper/config.json（旧名，保留兼容）→ 默认 http://127.0.0.1:6450
```

- 环境变量名留在各适配器里——那种名字本身就是 agent 的事实。`config.json` 由 core 读写、各 agent 共用一份：「连到哪台网关」是全机一个事实，没理由让每个 agent 各配一遍。
- 前几级写成非 http(s) 时**直接报错，不悄悄换成下一级**：用默认地址顶上去会让人以为配置生效了，然后在「明明配了却不生效」里绕很久。
- 这份文件是我们自己的，可以写；agent 的配置文件永远不写。
- `/agentfacade connect` 的归一化规则：没有 scheme 补 `http://`；scheme 是 `http` 且没写端口时补 `:6450`（`https` 不补，443 是它自己的默认）；末尾斜杠去掉；非 http(s) 一律拒绝且不写文件。写完立刻刷新一次——拉不到只报告原因、不回滚文件，换网络是正常操作。

## 密钥从哪来

与地址同一套分层：环境变量名是 agent 的事实，文件是全机一份。

```text
<PREFIX>_FACADE_API_KEY → FACADE_API_KEY → ~/.config/agentfacade/auth.json → 没有
```

- 形状与 pi 自己的 `auth.json` 一致（`{ "<provider>": { "type": "api_key", "key": "…" } }`，0600，原子写）：pi 用户已经熟悉这个文件，密钥落盘就不该再造一个私有格式。
- 坏 auth.json **只 warn、不中断**，降级成空密钥：这与地址那条「坏地址报错」相反，因为地址错了会连到错的地方，密钥错了只是不带鉴权，没必要挡住模型同步。
- 三个 agent 共用 `resolveHostAuthKey({ prefix })`：拼环境变量名的规则只写一处，否则三份实现里迟早有一份拼错。
- 密钥用于两处：拉目录的请求头、agent 自己的模型请求。DeepSeek Harness 的配置只承载 `apiKeyEnv`（名字），密钥本身不进配置文件。

## 定时轮询

`core/poll.ts` 的 `startCatalogPolling({ prefix, refresh, apply })` 是唯一入口：

- `refresh` 只负责「拉一次并交出 id」，`apply` 只负责「让新清单生效」；**变化判定与「变了才 apply」在 core**。
- 为什么不让每个 agent 自己拼：第一版三个端各自组装轮询，写法一歪就变成「每轮重写一次配置」，dsh 那次尤其危险——写 settings 是有副作用的持久化动作。现在 host 只交两个函数，想歪也歪不到哪去。
- 用 `setTimeout` 链而不是 `setInterval`：上一次没回来就不排下一轮，慢网关不会把请求堆起来。定时器一律 `unref()`，轮询不该拦住进程退出。
- 间隔：`<PREFIX>_FACADE_REFRESH_MS` → `FACADE_REFRESH_MS` → `config.json` 的 `refreshMs` → 300000，钳到 ≥ 30000。这条链**故意宽容**：间隔是节奏旋钮，写坏只会得到不合适的节奏，钳回下限没有静默危害；按地址的规矩来会让一次手滑挡住整个模型同步。
- 变化只在 id 集合有增删时算（重排不算）：用户看到的清单没变，就不该有日志、也不该重新注册。

## 状态机：拉不到怎么办

所有 agent 必须给出同一个答案，所以这段在 `core/sync.ts`：

- 拉不到、空清单、非 JSON、`data` 不是数组 —— 都**不替换**已注册的清单。
- 空清单算**失败**而不是成功：拿 0 条去注册等于把用户手上的模型清空（整表替换语义）。
- 调用方取消（agent 重刷时 abort 上一次）**不算错误**，不写 `lastError`：把它记成错误会让每次正常启动都多一条吓人的警告。
- 地址写错时不覆盖上一次的网关地址，否则排障时连「原来指哪」都看不出来。

## 探活（只接了 pi）

`core/probe.ts` 按模型并发发一条最小 chat 请求（`max_tokens: 1`），去重、并发上限、超时、分类都在 core；host 只负责取模型名、调一次、把表打印出来。OpenCode 与 dsh 本轮不接线，但可以直接复用同一份 core，不需要各抄一份。

状态与处置都在 core 判定，host 只打印状态名：

| 状态 | 触发 | 用户的下一步 |
| --- | --- | --- |
| `ok` | 200 | 用这条 |
| `auth` | 401 / 403 | 查密钥 / 权限 |
| `quota` | **402 一律**（HTTP 语义就是 Payment Required，不看正文）；其它状态（含 502）错误体命中额度词（`exceed quota limit` / `quota exceeded` / `insufficient_quota`）也算——额度耗尽该充值/换号、重试无用，所以 502 里额度词优先于上游标记 | 换账号或充值 |
| `missing` | 404 | 改模型 id |
| `throttled` | 429 | 等一会再来 |
| `upstream` | 502 且错误体没有额度词、但能认出上游 400/403；`code`/`status` 必须与 `upstream`/`provider` 同现才认（见「已知缺口」） | 看 `detail` 的上游原文 |
| `timeout` | fetch 抛 AbortError 或本地计时器到点 | 重试或调高预算 |
| `unreachable` | 连接类错误 | 查网关地址 |
| `cancelled` | 调用方的 signal 先到（不是超时，也不是模型的错） | 重新发起 |
| `unclassified` | 以上都不认 | 读 `detail` 原文 |

**已知缺口**：`upstream` 的判定是「同现」而非精确关联——正文里 `code`/`status` 与 `upstream`/`provider` 同时出现就算，因此网关自己的 `code:403` 若恰好与正文中某处 `provider` 同现，也可能被当成上游标记。detail 保留原文，用户可据以纠正；这只影响一条参考标签，不影响请求本身。
`detail` 取错误体摘要并截断；错误体先截到 4096 字符再压平/解析——分类只要开头那点线索，几 MB 的正文不该被复制三份。`upstream` 是纯字符串时也要收进摘要。非 JSON、空体、超长体都不能抛；回显的密钥抹成 `***`。`concurrency`/`timeoutMs` 非正、NaN 一律钳回默认值：`concurrency: 0` 钳回默认而不是 1（1 会把全量探活拉成串行），绝不留零 worker 静默返回空表。最坏耗时由 `probePlan` 算出，宿主只把它印成「探活 N 条模型，最坏约 M 秒」，在 await 之前发出；能拿到 ctx 的取消信号就透传给每条 fetch，拿不到就如实不声称支持。URL 与目录一样锁 `dialect=openai`，不依赖网关默认值。

为什么不做成派单闸门：探活测的是一次最小请求，真实派单还带着会话头、思考档位、长上下文。实测探活 502 的模型照样跑得动，所以输出末尾固定一句「探活结果仅供参考，不是派单闸门」，且这条判断不写在 agent 的命令里。

## pi

- 用扩展注册路径（`registerProvider`），不是写 `models.json`。
- **`cost` 与 `compat` 必须写在每条模型上**。pi 对两条注册路径的归一化程度不同（1.5.2，`provider-composer.js`）：`models.json` 一路由 `modelFromJson()` 补 `cost` 默认值、`applyModelsJson()` 用 `mergeCompat` 把 provider 级 `compat` 并进每条模型；扩展注册一路的 `extensionModelFromDefinition()` 只是展开定义，provider 级的一个都不下发。缺了会怎样（实测）：
  - 缺 `cost`：请求在第一个 SSE 事件上抛 `Cannot read properties of undefined (reading 'tiers')`。
  - 缺 `compat.sendSessionAffinityHeaders`：不发 `x-session-affinity`，网关拿不到会话 id，回 `502 … MissingSessionID`。
  - 缺 `compat.forceAdaptiveThinking`：pi 不发 `output_config.effort` 而发 `thinking.budget_tokens`，`thinkingLevelMap` 整条被绕过。
- `thinkingLevelMap` 的档位收敛**往下取，不往上取**：档位是成本与延迟的旋钮，pi 默认 medium，往上取等于把「没写档位」变成「思考拉满」。
- 已知行为：网关档位里出现 `default`（pi 没有这一档）时它排在已知档位之后，于是 pi 的 `max` 会映到 `default`。这是上游报出来的形状，不是插件的选择。
- 写缓存价恒为 0：网关只报输入 / 输出 / 读缓存三侧。网关没报价时四格全 0——0 在 pi 里表示不计价，pi 没有「未知价格」这个状态。

## OpenCode

- 必须用 **v2 插件 API**：default 导出 `{ id, setup(ctx) }`，provider 通过 `ctx.provider.transform((editor) => editor.add({ info, models }))` 注册。v1 的函数返回 hooks 形状在 2.2.7 上直接加载失败：`Plugin must export a default definition with an id and an effect or setup function`。
- 实测的运行时形状（2.2.7，用最小插件把对象 dump 出来比对）：

  ```text
  模型：{ id, modelID, providerID, name,
          capabilities: { tools, input: [...], output: [...] },
          variants: [], time: { released }, cost: [], status: "active",
          enabled: true, limit: { context, output } }
  provider：{ id, name, activation, package, settings: { baseURL, apiKey } }
  ```

- **v2 没有 `capabilities.reasoning`**。可选变体挂在 `variants`，但条目形状无文档、实测默认空数组，所以档位在 OpenCode 上不表达——不发明字段。
- `package` 必须是导出 `model(modelID, settings)` 的模块。用 `@ai-sdk/anthropic`（v1 写法）能加载但请求失败；`@opencode/ai/providers/anthropic` 可用。
- 配置键是复数 `plugins`，条目必须是目录。
- `toolCall === null` 时按支持处理（与 pi 缺省一致）；`modalities === null` 时退回录制常量。

## DeepSeek Harness

- 生效落点是 `ctx.settings`（dsh 自己的持久化 API，落到 profile patch，等价于在设置页保存一次）。不碰 `cordis.patch.yml` / `settings.yaml`——那是用户的配置，绕过 dsh 的校验与备份。
- 写 API 按**能力探测**分叉，不看版本号（上游以 rc.N 高频迭代，接口形状反而稳定）：

  | 能力 | 有 | 没有时的降级与代价 |
  | --- | --- | --- |
  | `mutate` | 只写命名路径 | 退到 `replace`/`update`：整段提交，从脱敏快照重建会静默删掉凭据字段 |
  | `expectedRevision` | 冲突可检测 | 读一次写一次，冲突不可检测 |
  | `isVolatilePath` | agent 拦坏配置 | 插件自己按 `llm-pi-ai` 的 Config 形状校验（providers 在各版本都是 volatile） |

  走了哪条分叉要留下痕迹（状态与日志里记 `mutate+revision` / `replace` 之类）。
- `llm-pi-ai` 的模型级 `reasoningEfforts` **不是字符串数组**，是 `false | dict`：键必须落在封闭词汇 `off|minimal|low|medium|high|xhigh|max`，值是协议里的拼写，`off` 可以是 `null`（什么也不发）。塞成数组会被 schemastery 拒：`reasoningEfforts expected false | {…} but got [...]`，于是写入必然失败、agent 完全不可用。交集为空时整个字段省略（不是 `[]`，也不是 `{}`）。
- 默认方言是 `openai-completions`，不是 pi 那边的 `anthropic-messages`。实测对网关各发一次最小请求：anthropic 路径的 thinking 块 `signature` 是空串（需要 `allowEmptySignature` 兼容开关才容忍），多轮回放有风险；openai 路径的推理走 `reasoning_content`，无签名回放问题。
- `baseURL` 口径跟着方言变：`openai-completions` 带 `/v1`，`anthropic-messages` 到路由根。
- `apiKeyEnv` 只写环境变量**名**，密钥本身绝不进配置。


## 会话身份头

网关要能区分「哪个会话／哪个子代理」发的请求。这一层只在**出站请求**上加头，不参与 provider 注册，因此与网关是否可达无关：钩子在扩展加载时注册，网关挂了也照样挂上。

共享的是**归一化**，不共享注册方式（每个宿主的注入点各不相同，且头名里有宿主词汇）：

| 位置 | 内容 |
| --- | --- |
| `core/session-headers.ts` | `normalizeSessionId` / `normalizeAgentName` / `buildSessionHeaders`。头名由调用方传入，core 不出现任何宿主词汇 |
| `hosts/*/session-headers.ts` | 各自认识自己的钩子形状与头名 |

三条不变量（都是「写错就静默不生效或弄坏路由」的地方，各有能变红的用例）：

1. **根会话一个头都不写**：有没有父会话是唯一的判据，不是「值解析到了没有」。子会话里父 id 读不到时，子会话自己的 id 照发。
2. **解析不到就省略，绝不写空值**：空串头表示不了「没解析到」，只会把网关带偏。
3. **不碰路由头**：pi 的 `x-session-id` / `x-session-affinity` 会被 pi-subagents 改写成父会话 id 用来命中父会话的 prompt cache，覆盖它就是让父会话缓存失效。

各宿主的事实：

| 宿主 | 注入点 | 写的头 | 拿不到的 |
| --- | --- | --- | --- |
| pi | `before_provider_headers`（可原地改 `event.headers`）；`before_agent_start` 先记权威 agent 名（`<active_agent name="…">`） | `x-pi-session-id`、`x-parent-session-id`、`x-agent-name` | — （父 id 取自 `sessionManager.getHeader().parentSession` 指向的文件首行，有界读 64KB） |
| opencode | `ctx.session.hook("model.request")` 改 `event.headers` | 只补 `x-agent-name` | 会话与父会话 id：opencode 原生就发 `x-opencode-session-id` / `x-opencode-parent-session-id`，不重复发 |
| dsh | cordis 事件 `llm-pi-ai/request-headers`（waterfall） | `x-dsh-session-id` | 父会话 id 与 agent 名：该钩子的上下文只有 `provider/model/sessionId/purpose/baseURL` |

dsh 的两处宿主约束值得记下：它的 provider profile 只有**静态** `headers`（`z.dict(z.string())`），放不下每会话不同的 id，所以必须走请求级钩子；那条 waterfall 的监听器必须**恰好**调一次 `next()`（它代表剩下的监听器，重调会让下游执行两遍），且抛错会让整次调用以 `REQUEST_HEADERS` 失败，所以写头失败只丢这一格头。
## 测试契约

- `core`：纯函数 + 一次 fetch，用例注入 fetch，不起网络。
- 每个 `hosts/*`：假 agent API，断言注入的配置对象逐字（手写快照），并断言失败路径不注册。
- 网关报文形状只有一份，在 `core/test/fixtures/gateway-openai.json`；适配器测试直接构造 `ModelSpec[]`。
- `scripts/check-boundary.ts` 管层与层之间的边界，属于全仓，不属于任何单个适配器。
- 每条分叉（能力探测、方言、cost 语义）都要有能变红的用例：改一处实现，跑测试必须红。

## 非目标

- 不做局域网扫描找网关：只试解析出的那一个地址。猜错等于对着错的网关取清单。
- 不在 `core` 里做任何 agent 特化。需要新的事实，先进 `ModelSpec`，再由各适配器决定怎么表达。
