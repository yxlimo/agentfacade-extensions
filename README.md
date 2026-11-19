<h1 align="center">agentfacade-extensions</h1>

<p align="center">
  <strong>AgentFacade 网关的模型目录，直接进你的 agent 宿主。</strong><br>
  一份 core，三个适配器：pi、OpenCode、DeepSeek Harness。
</p>

## What is agentfacade-extensions?

网关的模型清单是活的：面板上换一次主路由、加一个模型，清单就变了。而宿主的模型表是死的——写进 `models.json` 或 `opencode.jsonc` 的那一刻是什么，之后就一直是什么，直到有人想起来再跑一遍同步。三个宿主就是三份各自过期的副本。

这个插件把那条线接上了。宿主启动时拉一次网关的 `GET /v1/models`，映射成该宿主自己的 provider 配置，在运行时注册进去；宿主需要刷新目录时再拉一次。面板上改了主路由，重启宿主就能看见。

三条约束贯穿全部三个宿主：

- **不写你的配置文件。** 注册只走宿主自己的运行时 API，`models.json`、`opencode.jsonc`、`cordis.patch.yml` 一个字节都不动。
- **拉不到就不注册，而不是注册成空。** 网关不可达、超时、返回空清单——一律保持原状，你原有的模型继续可用，只留一行警告。
- **provider 名独立。** 都叫 `agentfacade`，与你已有的 provider 各走各的，不覆盖。

为什么这样做、各宿主上量到的事实（pi 的 `cost`/`compat` 逐条要求、OpenCode v2 的注册面、DeepSeek Harness 的能力分叉）都在 [docs/design.md](docs/design.md)。

## Quick start

### pi

```bash
ln -s "$PWD/hosts/pi" ~/.pi/agent/extensions/pi-agentfacade
```

重启 pi，`/facade-models` 显示注册了几条模型、来自哪个网关、最后一次刷新时间；`/facade-models refresh` 立刻重拉。

只试一次不改环境：`pi -e ./hosts/pi --list-models`。

### OpenCode

`opencode.jsonc` 加一条**目录**路径（键名是复数 `plugins`，写成 `.ts` 文件会报 `configured plugin path must be a directory`）：

```jsonc
{
  "plugins": ["/absolute/path/to/agentfacade-extensions/hosts/opencode"]
}
```

需要 OpenCode 2.x：v1 的插件形状（函数返回 hooks）在 v2 上加载即失败。

### DeepSeek Harness

以 cordis 插件形式加载 `hosts/dsh`，入口是 `apply(ctx, config)`。provider 通过 `ctx.settings` 写进 `llm-pi-ai` 的 `providers.agentfacade`，等价于在设置页保存一次——不落 YAML，不碰 `cordis.patch.yml`。

### 网关在哪

默认 `http://127.0.0.1:6450`。指到别处用环境变量，或写 `~/.config/buddy-helper/config.json`：

```bash
FACADE_GATEWAY=http://gateway.example:6450 pi
```

```json
{ "gateway": "http://gateway.example:6450" }
```

宿主自己的变量名优先（pi 是 `PI_FACADE_GATEWAY`，OpenCode 是 `OPENCODE_FACADE_GATEWAY`，dsh 是 `DSH_FACADE_GATEWAY`）。写错的地址会直接报错，不会悄悄退回默认值。
