# pi-agentfacade

让 pi 自己从网关拿模型清单，不用手工维护 `~/.pi/agent/models.json`。

这是一个 pi 扩展（`package.json` 的 `pi.extensions` 指向 `index.ts`）。pi 启动时
它拉一次 `GET {gateway}/v1/models`，映射成 provider `agentfacade` 注册进去；pi 需要
刷新模型目录时再拉一次（`refreshModels`），所以网关改了主路由之后不用重启 pi
（`/facade-models refresh` 立刻生效）。

## 装

pi 的扩展发现位置有三种，选一种：

```bash
# 只在这一次启动里用（验证最快，不写入任何配置）
# 只在这一次启动里用（验证最快，不写入任何配置）
pi -e ~/extensions/agentfacade-extensions/hosts/pi --list-models

# 装成常驻：软链到 pi 的扩展目录（这台机上的其它本地扩展都是这么装的）
ln -s ~/extensions/agentfacade-extensions/hosts/pi ~/.pi/agent/extensions/pi-agentfacade

# 或者交给 pi 记进 settings.json（见下面的坑）
pi install ~/extensions/agentfacade-extensions/hosts/pi
```

**坑：`pi install` 在「settings 由外部管理」的机器上会被回滚。** 若 pi 是被
home-manager / nix 之类的 wrapper 启动的，那个 wrapper 通常每次启动都会拿一份
生成的 settings 去覆盖 `~/.pi/agent/settings.json`（数组是整段替换，不是合并），
于是 `pi install` 写进去的条目下次启动就没了 —— 现象是「今天好使，重启静默失效」。
这种机器用软链，别用 `pi install`。

注意 pi 不扫当前目录，在这个目录里直接跑 `pi` 不会加载它。

## 网关地址从哪来

四级：

1. `PI_FACADE_GATEWAY`
2. `FACADE_GATEWAY`
3. `~/.config/buddy-helper/config.json` 的 `gateway` 字段
4. `http://127.0.0.1:6450` —— 本插件自己的兜底（网关一般就跑在本机）。

```json
{ "gateway": "http://gateway.example:6450" }
```

前三级都没有时就用第四级，插件开箱能用。只试这一个地址，不做局域网扫描：扫描要花时间
且没把握，而扩展工厂在 pi 的启动路径上被 await —— 猜错（本机还是局域网那份）等于对着
错的网关取模型清单，报出来的东西没意义。

默认值连不上就打一行警告（带地址）、不注册 provider，models.json 那条继续生效。
环境变量或配置文件里的地址写错成非 http(s) 也**不注册**、直接报错 —— 拿去请求只会得到
一句看不懂的 `fetch failed`，不如当场说清楚。

## 与 models.json 的关系：替代

插件接管 pi 这一侧的模型清单，`~/.pi/agent/models.json` 不再需要手工维护，也不需要
为它留任何条目。provider 名是独立的 `agentfacade`，不与 `models.json` 里可能存在的
条目撞名。

网关拉不到时本插件**不注册**，pi 继续用它原有的清单，会话照常能开。

拉不到、拉回来是空清单、或者网关答的不是 JSON —— 都只留一行警告，不注册，
**绝不注册一个空的 models 列表**：legacy 形式的 `models` 是替换语义，注册空数组
会把用户已有的模型清空。

## 字段映射

| pi | 网关 |
| --- | --- |
| `baseUrl` | 网关根地址（pi 走 Anthropic 方言，自己拼 `/v1/messages`） |
| `api` | 固定 `anthropic-messages` |
| `apiKey` | 固定 `public`（网关跑 public 模式时不校验） |
| `models[].compat` | `forceAdaptiveThinking` + `sendSessionAffinityHeaders` 都开（provider 级不写，扩展注册路径不读它） |
| `models[].id` / `name` | `id` / `name`（网关没给名字时 core 退回 `id`） |
| `models[].reasoning` | `capabilities.reasoning.supported`，缺了按 `true`（不知道不等于不支持） |
| `models[].input` | 固定 `["text","image"]` |
| `models[].contextWindow` | `limit.context`，缺了 200000（core 的缺省） |
| `models[].maxTokens` | `limit.output`，缺了 4096（core 的缺省） |
| `models[].thinkingLevelMap` | `capabilities.reasoning.effort` 按 `level_map()` 的规则（往下取，不往上取；只有 `off` 的模型每一格都是 `off`） |
| `models[].cost` | 网关的 `cost` 三侧（输入 / 输出 / 读缓存，每百万 token、美元）→ pi 的四格；写缓存价恒 0，见下一节 |

映射规则就是这一层自己的约定：`catalog.ts` 怎么写，`fixtures/expected.ts` 那份手写快照
就怎么记。改映射要同时改快照 —— 两边一起动是刻意的，否则「映射改了但测试还绿」。

**已知行为**：网关报的档位里出现 `default`（pi 没有这一档）时，它排在已知档位之后，
于是 pi 的 `max` 会映到 `default`（`test/check.ts` 里 `SPECS` 的 `model-02` 就是这样）。这不是插件的选择，
是上游报出来的形状 —— 改掉就与网关对不上了。

## `cost` 与 `compat` 为什么写在每条模型上

不是啰嗦：pi 对两条注册路的归一化程度不一样（1.5.2，`dist/core/provider-composer.js`）。

- `models.json` 那一路：`modelFromJson()` 补 `cost` 默认值，`applyModelsJson()` 再用
  `mergeCompat` 把 provider 级 `compat` 并进每条模型。
- 扩展注册那一路：`extensionModelFromDefinition()` 只是把定义展开，provider 级的
  `cost`/`compat` 一个都不下发。

而我们用的是扩展注册（`registerProvider`）。缺了会怎样（都在 pi 1.5.2 上实测）：

| 缺什么 | 现象 |
| --- | --- |
| `cost` | 请求在第一个 SSE 事件上抛 `Cannot read properties of undefined (reading 'tiers')`（`calculateCost` 读 `model.cost.tiers`），每次请求必炸 |
| `compat.sendSessionAffinityHeaders` | 不发 `x-session-affinity`（`openrouter` 格式才用 `x-session-id`），网关拿不到客户端会话 id：`502 upstream HTTP 400 MissingSessionID` |
| `compat.forceAdaptiveThinking` | pi 不发 `output_config.effort`，改发 `thinking.budget_tokens` —— 上面那张 `thinkingLevelMap` 整条被绕过 |

所以 `toPiModelEntry()` 给每条模型都写上这两格。`cost` 的四个数字来自网关的三侧报价
（每百万 token、美元）：`input` / `output` / `cacheRead`；**写缓存价恒为 0**，网关不报这一项。
网关没报价（`cost: null`）时四格全 0 —— 0 在 pi 里表示不计价，与「没报价」在 pi 侧不可区分
（那是 pi 的成本统计口径，不是我们的断言；pi 没有「未知价格」这个状态）。快照用例把它们算在
内：删掉任一条就红。

## 命令

```text
/facade-models          当前注册了几条模型、来自哪个网关、最后一次刷新时间
/facade-models refresh  立刻重拉一次，并替换已注册的清单
```

启动时网关不可达（`/facade-models` 会显示 `NOT registered`）也不要紧：网关起来之后
跑一次 `/facade-models refresh`，provider 就补注册上了。

## 超时与启动开销

所有请求带超时：默认 1500ms（`DEFAULT_TIMEOUT_MS`），失败就放弃本次注册。pi 的扩展
工厂是 async 且被启动路径 await，所以这个数字直接等于「网关挂掉时 pi 多等多久」。
实测（本机，pi 启动基线 1352ms）：

| 情况 | 墙钟 | 结果 |
| --- | --- | --- |
| 网关可达 | 1573ms | 注册 17 条 |
| 网关不可达（关着的端口） | 1347ms | 不注册，退回 models.json 那 16 条 |
| 网关黑洞（不回包） | 1500ms 后放弃 | 不注册 |

不可达那两行分别走两条路：连接被拒是立即返回的（不等超时），只有「连得上但不回话」才
会吃满 1500ms。所以最坏情况是 pi 启动多等 1.5 秒，正常情况几乎不增加开销。

## 测

```bash
pnpm test        # 85 条用例，起假网关跑真工厂
pnpm typecheck   # 连 test/ 一起类型检查
```

离线：假网关是 `test/fake-upstream.ts` 起的 127.0.0.1 随机端口；期望值分两处：

- `test/check.ts` 里的 `SPECS`：**17 条显式 `ModelSpec`** —— 宿主的输入面。覆盖映射真正要处理的
  形状：`off` 单独一档、四档齐全但夹着 `default`/`none`、`midium` 这种拼错的档位、只有 `off` 的
  模型。**这里没有网关报文的拷贝**：条目长什么样是 core 的事，形状只留一份（在 core 的测试里），
  网关换个渲染不会把这一层拖下水。
- `fixtures/expected.ts`：期望配置的**手写快照**（`EXPECTED`），用例拿 `SPECS` 映射出来的整份
  provider 配置与它逐字比对 —— 那两格 `cost`/`compat` 也在比对范围内，删掉任何一条就红。
  它不由任何程序生成；改映射要同时手改它。

注册路径（真起假网关、走真 fetch）那几条只需要「有 N 条能过 core 的清单」，所以假网关只回
`{ data: [{ id }] }` —— 条目的其余字段由 core 归一，不在这里重复声明。
