# dsh（DeepSeek Harness）适配：接口事实与落点决定

查证日期 2026-11-19。**结论先给**：三版接口一致，不需要版本分支；生效落点是 `ctx.settings`
（宿主自己的持久化 API），不是插件去写 YAML。

## 版本矩阵（都实测过）

| 位置 | 版本 | 说明 |
| --- | --- | --- |
| 本机 CLI `/run/current-system/sw/bin/dsh` | `0.2.2-rc.1` | nix store，`@deepseek-ai/*` 全套可读（类型已 vendor 到 `reference/dsh/api/`） |
| 容器镜像 `dsh-plus:0.2.1-rc.2-r1` | `0.2.1-rc.2` | 用户实际在跑的那套 |
| 上游最新 release | `dsh-v0.2.2-rc.5`（2026-11-11 ~ 11-18 连续几个 rc） | master 源码 |

上游以 `rc.N` 高速迭代（0.2.2 从 11-04 到 11-18 出了 5 个 rc）。所以适配**只许依赖下面这些
被三版共同验证过的接口**，不要用内部字段。

## 三个 llm seam（`ctx.llm`）

`0.2.1-rc.2`、`0.2.2-rc.1`、`master` 三版都有，签名与语义一致：

| API | 用途 | 对本插件 |
| --- | --- | --- |
| `registerAdapter(providers: string[], adapter: LlmAdapter)` | 注册一个 provider 路由**由谁服务**（需要自己实现完整 LLM 适配器） | **不用** —— 那是重写 `llm-pi-ai` |
| `registerConfigurableProviders(entries)` | 把「某个适配器能通过配置激活哪些路由」登记到目录里，供设置界面渲染 | 不用（那是 `llm-pi-ai` 自己的事） |
| `registerModelDiscovery(settingsNs, discover)` | 代替某个设置命名空间去**问端点「你有哪些模型」** | 不用（`llm-pi-ai` 已占用同一 ns，重复注册会 `DUPLICATE_DISCOVERY`） |

## 生效落点：`ctx.settings`（三版一致）

```ts
declare class SettingsForms {
  get writable(): boolean
  get documentPath(): string          // profile patch 的路径，只读展示用
  describe(opts?): SettingsDescriptor[]   // 含 ns / schema / value / revision
  update(ns, patch, expectedRevision?): Promise<void>
  replace(ns, section, expectedRevision?): Promise<void>
  mutate(ns, ops: SettingsPathOp[], expectedRevision?): Promise<void>
}
```

要点（源码核实）：

- 写入落到 **profile patch**（`configEditor.edit`），不是直接改文件——这是宿主自己的持久化路径，
  等价于「用户在设置页保存了一次」。
- `expectedRevision` 是乐观并发：版本不符抛 `SETTINGS_CONFLICT`（带 expected/actual），要重读再写。
- `mutate` 只接受 **volatile 路径**（`isVolatilePath`），非 volatile 直接抛
  `Config field "…" is not volatile`；`mutate` 的价值在于**不必重述被脱敏的密钥字段**
  （`replace`/`update` 从脱敏文档重建会静默删掉 secret）。
- `settings.yaml` 在三版里都已是**遗留格式**：启动时被 `importLegacyDocument()` 导入 profile patch
  后改名为 `settings.yaml.imported`。所以文档里那种 `llm-pi-ai: providers:` 的写法是导入期形态。

## 适配器必须做的事

1. 从 `describe()` 里找到 **`llm-pi-ai` 那个 entry 的 ns**（按 schema 里有 `providers` 判定，
   不要写死 id —— 它可能是 `llm-pi-ai` 也可能是 `@deepseek-ai/dsh-llm-pi-ai`）。
2. `mutate(ns, [{ op: 'set', path: ['providers', 'agentfacade'], value: <provider> }], revision)`。
3. provider 形状按 `llm-pi-ai` 的 Config（`reference/dsh/api/dsh-llm-pi-ai.0.2.2-rc.1.d.ts`）：
   `displayName` / `api` / `baseURL` / `models[]`（`id`、`name`、`contextWindow`、`maxTokens`、
   `reasoningEfforts`）/ `apiKeyEnv`。
4. 冲突（`SETTINGS_CONFLICT`）→ 重读 `describe()` 再试一次，最多一次；仍失败就报错，不循环重试。

## 红线

- **不许自己写 `cordis.patch.yml` / `settings.yaml`**：只用 `ctx.settings`。宿主没有这条 API
  或路径非 volatile 时，**报错说明**，不要退化成写文件。
- 不许依赖 `ctx.settings` 之外的内部实现（`configEditor` 是 `settings` 的内部注入，别直接碰）。
- `apiKeyEnv` 引用的凭据由宿主解析；**不要在配置里放密钥**。

## 版本分叉策略（主干走最新，保留向下兼容）

**主干**：按最新 master（`rc.5`）的接口写，主路径只用最新形态。
**分叉**：分叉逻辑必须保留，但**按能力探测，不按版本号字符串**——形状用 `typeof x === 'function'` 判定，
降级路径要能在旧版上跑通，并且**每一条降级路径都要有用例**（假宿主构造，见下）。

| 分叉点 | 最新版形态 | 降级（旧版没有时） |
| --- | --- | --- |
| 写设置 | `settings.mutate(ns, ops, revision)`（只写命名路径，不重述脱敏密钥） | `settings.replace(ns, section)`；此时**必须先从 `describe()` 拿完整 section 再合并**，且要接受「密钥字段会被清掉」——能不用就不用，用了要在报告里写明代价 |
| 并发保护 | `expectedRevision` → `SETTINGS_CONFLICT` | 没有 revision 参数时读一次写一次，冲突无法检测，明确记为「旧版无并发保护」 |
| 页面/形态 | `describe()` 返回 `schema`/`value`/`revision` | 缺 `revision` 就退化成「读-改-写」；缺 `schema` 就改用配置项白名单判定 |
| 位置判定 | `isVolatilePath` 拒绝非 volatile 路径 | 旧版没有该检查时，自己按 `llm-pi-ai` 的 Config 形状校验（`providers` 是 volatile 这点三版一致） |

分叉层的实现要求：

- 探测结果**一次性**算好并缓存（`capabilities()`），不要每次调用都 `in` 判定。
- 任何分叉都要在 `describe()`/日志里留下**选了哪条路径**的可见痕迹，便于排障。
- 测试要有**双宿主**：一个按最新形态的假宿主，一个故意删掉 `mutate`/`revision` 的旧形态假宿主；
  两条路径都必须覆盖，且**互相能证明差异**（同一场景在旧形态走 replace、新形态走 mutate）。

## 已定论

`providers` 在 `llm-pi-ai` 的 Config schema 里是 **volatile**
（master `src/config.ts`：`providers: z.dict(profile).default({}).volatile()`），
所以 `mutate(ns, [{ op: 'set', path: ['providers', '<route>'], value }])` 是合法路径，
不需要整段 `replace`。

## 方言：默认 openai-completions（实测依据）

2026-11-19 对 `http://127.0.0.1:6450` 各发一次最小真实请求（`max_tokens:1`，带 `x-session-id`）：

| 方言 | 结果 | 关键细节 |
| --- | --- | --- |
| `anthropic-messages`（`POST /v1/messages`） | 200 | 返回原生 anthropic 形状，但 thinking 块是 `{"type":"thinking",…,"signature":""}` —— **签名为空** |
| `openai-completions`（`POST /v1/chat/completions`） | 200 | 返回 `chat.completion`，推理走 `reasoning_content` |

结论：**dsh 默认用 `openai-completions`，`baseURL` 带 `/v1`**。

理由（按证据，不是偏好）：

1. 空 signature 在 anthropic 多轮回放上是已知雷点 —— pi-ai 专门为此提供 `allowEmptySignature` 兼容开关，
   说明「空签名被原样回放」是真实会出问题的路径。dsh 的 `llm-pi-ai` 也走 pi-ai，同样受此约束。
2. 网关明确产出 `reasoning_content`，`openai-completions` 是它的原生表达，没有签名回放问题。
3. 用户现有的 `docs/reference/dsh/provider-patch.example.yml` 走的就是 `openai-completions`，
   默认对齐它，出问题时差异面更小。

`anthropic-messages` 保留为**可配置选项**（`api` 字段可改），但必须在 README 里写明空签名那一节的风险。
如果将来网关开始返回真实签名，再把默认翻过去。
