# reference/ — 第三方约定的去处（只放链接，不放拷贝）

这里**不放任何原文摘录**，只写「想确认某件事，去哪儿读」。

为什么不放拷贝：

- 拷进来就是一份会过期的副本 —— 宿主升级后没人会记得回来重拷，反而让人以为那就是当前形状。
- 这些条目里混着**别人仓库里的私有配置**（`~/.config/opencode/`、`~/nix-config/`）。本仓是要发
  npm 包、要公开的，私有内容不该跟着走。
- 读原处不需要额外授权：子代理 bash 沙箱的读根是 `/`（Landlock 只锁写），所以「给出路径」和
  「拷一份进来」在能力上没有区别，只是后者多了上面两个代价。

## 想确认什么 → 去哪儿读

| 要确认的事 | 读哪里 |
| --- | --- |
| dsh 的 `llm` / `settings` 接缝真实签名（`registerAdapter`、`registerConfigurableProviders`、`settings.mutate`） | 已安装的 dsh 包：`ls -d /nix/store/*dsh-*/lib/node_modules/@deepseek-ai/dsh` 后读其中 `src/**/*.d.ts` 与 `docs/`。上游：<https://github.com/deepseek-ai/deepseek-harness>（`apps/cli`） |
| dsh 版本与容器版本的差异 | `dsh --version`；容器镜像 tag 另行确认。三个版本（容器 / 本地 CLI / 上游 master）的接缝是否一致要逐个对照读，不看版本号下结论 |
| cordis 插件的最小形态（`export const name` / `Config` / `apply`） | `~/projects/dsh/plugins/dsh-profile-context-lite/`（`index.js` + `package.json` + `cordis.patch.yml`） |
| provider 是怎么挂进 `llm-pi-ai` 的（`cordis.patch.yml` 的真实写法） | `~/projects/dsh-plugins/bli-sync/cordis.patch.yml` 与 `~/projects/dsh-plugins/bli-sync/lib/` |
| profile 的 seed patch 形态（顶层数组、允许 `!!js` 表达式） | `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| 我们这份 provider patch 的实测可用形态 | `~/nix-config/modules/nixos/nas-dsh.nix`（Nix 生成，实际部署的那份） |
| opencode 配置的真实形状（`providers.<id>`、`plugins` 是复数数组） | `~/.config/opencode/opencode.jsonc`、`~/.config/opencode/shay-models.jsonc`；schema：<https://opencode.ai/config.json> |

## 规矩

- 需要新的第三方证据时：**读原处，把路径写进上表**，不要拷文件进来。
- 上表里的路径是本机事实，可能随版本变化；发现对不上就更新这一行，不要「顺手修好」拷来的副本。
- 本目录不参与 `typecheck`、不参与 lint，因为它没有代码可检。
