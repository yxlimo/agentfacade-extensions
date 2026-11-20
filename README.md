# AgentFacade Extensions

自动同步 AgentFacade 网关配置的模型。

支持 pi、OpenCode、DeepSeek Harness。

## 它是什么

把 AgentFacade 网关里配好的模型，同步进你正在用的 agent。网关里加了模型、换了主路由，重启一下就能看见——不用手改 `models.json`，也不用再维护第二份清单。

## 快速开始

### pi

```bash
pi install npm:pi-agentfacade
```

重启 pi，`/agentfacade` 显示注册了几条模型、来自哪个网关、最后一次刷新时间。

### OpenCode

`opencode.jsonc` 里加一条（需要 OpenCode 2.x）：

```jsonc
{
  "plugins": ["opencode-agentfacade@latest"]
}
```

### DeepSeek Harness

```bash
dsh plugin --profile <profile> add dsh-agentfacade
```

### 连到网关

默认 `http://127.0.0.1:6450`。指到别处，用命令写进配置文件：

```text
/agentfacade connect 192.168.1.9          # → http://192.168.1.9:6450
/agentfacade connect 192.168.1.9:8000     # → http://192.168.1.9:8000
/agentfacade connect https://gw.example   # → https://gw.example
/agentfacade                              # 当前地址、来自哪一级、注册了几条模型
```

写进去的是 `~/.config/agentfacade/config.json`，也可以直接改它：

```json
{ "gateway": "http://192.168.1.9:6450" }
```

不想有文件就用环境变量，优先级高于上面那份：`PI_FACADE_GATEWAY`、`OPENCODE_FACADE_GATEWAY`、`DSH_FACADE_GATEWAY`，以及三者共用的 `FACADE_GATEWAY`。写错的地址会直接报错，不会悄悄退回默认值。

### 网关要密钥时

不配就不带鉴权（网关 public 模式）。要用密钥，任选一种，前面优先：

```text
PI_FACADE_API_KEY / OPENCODE_FACADE_API_KEY / DSH_FACADE_API_KEY   # 各自的
FACADE_API_KEY                                                     # 三者共用
~/.config/agentfacade/auth.json                                    # 落盘，形状见下
```

```text
/agentfacade key <token>     # 写进 auth.json（0600）、立刻生效、不回显 token
```

文件形状与 pi 自己的 `auth.json` 一致：

```json
{ "agentfacade": { "type": "api_key", "key": "…" } }
```

DeepSeek Harness 写进它配置的只有环境变量名（`apiKeyEnv`），密钥本身不进配置文件。

### 探活（pi，仅供参考）

```text
/agentfacade probe                  # 探当前已注册的模型
/agentfacade probe coder-a coder-b  # 只探指定的模型
```

逐个发一条最小 chat 请求，按「模型 / 状态 / HTTP 码 / 延迟」列出来；额度、鉴权、上游包装错误等有单独状态。

**探活结果仅供参考，不是派单闸门：探活失败不等于用不了，成功也不保证这一次请求能成。** 例如上游 400/403 被网关包成 502 时，真实请求照样可能可用。

### 模型清单自动同步

启动时拉一次，之后每 5 分钟一次：清单有增删才生效并记一行日志，拉不到就保留上一份。改间隔（下限 30 秒）：

```text
PI_FACADE_REFRESH_MS / OPENCODE_FACADE_REFRESH_MS / DSH_FACADE_REFRESH_MS
FACADE_REFRESH_MS
config.json 里的 { "refreshMs": 600000 }
```
