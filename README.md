<h1 align="center">AgentFacade Extensions</h1>

<p align="center">
  <strong>自动同步 AgentFacade 网关配置的模型。</strong><br>
  pi · OpenCode · DeepSeek Harness
</p>

## What is AgentFacade Extensions?

把 AgentFacade 网关里配好的模型，同步进你正在用的 agent。网关里加了模型、换了主路由，重启一下就能看见——不用手改 `models.json`，也不用再维护第二份清单。

## Quick start

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
