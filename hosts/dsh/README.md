# hosts/dsh — deepseek harness 宿主适配

把 AgentFacade 网关的模型清单写进 dsh 自己的 `llm-pi-ai` 配置，**不碰任何用户文件**。

```text
网关 /v1/models ──core──> ModelSpec[] ──hosts/dsh──> llm-pi-ai 的 providers.agentfacade ──ctx.settings.mutate──> 生效
```

## 生效方式

dsh 的生效途径是宿主自己的设置 API：`ctx.settings`（落到 profile patch，等价于用户在设置页
保存了一次）。插件**只**调 `ctx.settings`：

- 写设置：`settings.mutate(ns, [{ op: 'set', path: ['providers','agentfacade'], value }], revision)`
- 命名空间 `ns` 不写死：从 `describe()` 里找 schema 含 `providers` 的那条
  （没有 schema 的旧宿主退一步看 value 里有没有 `providers`）。
- 拿不到可用的写入 API（没有 `mutate`/`replace`/`update`，或 profile 不可写）就**报错说明**，
  绝不退化成写 `cordis.patch.yml` / `settings.yaml`，也不碰 `ctx.configEditor`。

## 版本分叉（按能力探测，不按版本号）

上游以 rc.N 高频迭代（实测 0.2.1-rc.2 / 0.2.2-rc.1 / master，接口形状一致）。探测结果只算
一次并缓存在 `state.capabilities` 上；实际走了哪条路会出现在日志与 `describe(state)` 里
（`Write path: mutate+revision` 这类字符串）。

| 分叉点 | 最新形态 | 降级与代价 |
| --- | --- | --- |
| 写 API | `mutate(ns, ops, revision)` | 没有就 `replace`/`update` 整段提交。整段提交必须先从 `describe()` 拿**完整 section** 再合并（`mergedSection`），否则同 ns 下别的键会被清掉；脱敏的密钥字段（`apiKeyEnv` 之类）本来就不在 `describe()` 结果里，重建文档时会被静默删掉 —— 这是降级路径的真实代价 |
| 并发保护 | `expectedRevision` → `SETTINGS_CONFLICT` 时重读 `describe()` 再试一次（只一次） | 旧宿主没有第三参：读一次写一次，冲突无法检测，`writePath` 记作 `mutate` / `replace` 而不是 `+revision` |
| volatile 判定 | 宿主 `isVolatilePath` 拒绝非 volatile 路径 | 没有这层检查时，插件自己按 llm-pi-ai 的 Config 形状校验（`validateProviderProfile`），不合格就拒绝写 —— 宿主不会替我们拦坏配置 |

`isVolatilePath` 是 mutate 的内部检查，vendor 的 `dsh-settings.d.ts` 里没有签名；插件对数组与
点路径两种形状都问一次，谁认用谁（都不认就当作「不是 volatile」拒绝）。

## 方言：默认 `openai-completions`（baseURL 带 `/v1`）

实测（docs/hosts-dsh.md，2026-11-19 对网关各发一次最小请求）：

- `anthropic-messages`：返回原生 anthropic 形状，但 thinking 块 `signature` 是**空串**。
  pi-ai 专门为「空签名被原样回放」提供 `allowEmptySignature` 兼容开关，dsh 的 llm-pi-ai 也走
  pi-ai，多轮回放同样有风险。
- `openai-completions`：推理走 `reasoning_content`，没有签名回放问题；用户现有的
  provider patch（`~/nix-config/modules/nixos/nas-dsh.nix`） 走的也是这条。

`anthropic-messages` 保留为可配置项（`api` 字段）。**如果切过去，请把上面那条空签名风险带上**：
这是已知雷点，不是偏好问题。将来网关开始返回真实签名，再把默认翻回去。

## 映射：ModelSpec → llm-pi-ai provider profile

```text
ModelSpec { id, displayName, reasoning, efforts[], contextWindow, maxOutputTokens,
            toolCall: boolean | null, modalities | null, cost | null }
  → { displayName, api, baseURL, apiKeyEnv,
      models: [{ id, name, contextWindow, maxTokens, reasoningEfforts? }] }
```

- **`reasoningEfforts` 不是数组，是 `false | dict`**（llm-pi-ai 的 Config，schemastery 校验）。
  曾经按「上游原样」发数组，实测该 Config 直接拒：
  `reasoningEfforts expected false | { [key: …]: string } but got [...]` —— 于是
  `settings.mutate` 必失败，宿主整个不可用。这是回归用例 `reasoningEfforts 不是数组` 钉住的事。
- dict 的规则：
  - 键 = dsh 的**封闭词汇** `off|minimal|low|medium|high|xhigh|max`（未知键被 schemastery 拒）；
  - 键顺序 = 网关顺序（不排序、不补档）；
  - 值 = 该档位在协议里发送的拼写（网关侧就是这个名字），`off` → `null`（什么也不发）；
  - 网关声明了 dsh 不认识的拼写（真网关出现过 `midium`）→ 丢掉；
  - 交集为空 → **整个字段省略**（不是 `[]`、也不是 `{}`）：省略 = 沿用已安装目录的能力声明。
- 缺省值（context 200000 / output 4096）由 core 负责，是所有宿主共享的网关约定。
- `toolCall` / `modalities` / `cost` 在这一版 llm-pi-ai 的 provider profile 里**没有对应的格子**，
  所以映射不表达它们（不是漏了、也不是被 0 抹平 —— core 交出来的区别还在，只是这个宿主没处放）。
  哪天 profile 支持了再在这里加，别在 core 里替它补默认值。
- `apiKeyEnv` 只放**环境变量名**（默认 `AGENTFACADE_API_KEY`），密钥本身绝不进配置。

## 失败行为

- 网关不可达 / 超时 / HTTP 错误 / 非 JSON / 空 `data: []` / 全部条目缺 id → **一律不写**，
  `state.lastError` 记原因，警告里说明保留了上一次的几份模型。
- 空清单不会覆盖上一次成功的清单（core 的状态机 + 这里「失败就直接返回」的守卫）。

## 测试

```text
node --experimental-strip-types hosts/dsh/test/check.ts     # 136 个断言
node --experimental-strip-types hosts/dsh/test/check.ts --dump   # 固定 catalog 走真实管线，打印 profile JSON（复验用）
node node_modules/typescript/bin/tsc --noEmit -p hosts/dsh/tsconfig.json

纯离线：假宿主（新形态 / 旧形态 / 无写入 API / 不可写）+ 注入 fetch。断言是**逐字快照**
（注入的 ops 与整段 section 都手写在 `test/check.ts` 里），不是 `typeof` 检查。

## 安装

安装是**用户**的决定，不是本仓的：本目录只是插件源码，测试不启动任何宿主。
