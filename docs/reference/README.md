# reference/ — 原样摘录的第三方参考件

这里的东西是**别的项目里的原文摘录**，为的是让受限的子代理（作用域只在本次项目树内）
能读到宿主的真实约定。它们不是本项目的代码：

- 不维护、不修 lint、不纳入 `typecheck`（根 `tsconfig.json` 只 include `core/` 与 `hosts/`）。
- 里面的未使用变量、风格问题都是原文如此，**不要为了消警告去改它们** —— 改过就不再是原文，
  读的人会以为宿主就是这么写的。
- `dsh/`：cordis 插件样例（`cron-runner`、`profile-context-lite`）与 `bli-sync` 的两个文件。
- `opencode/`：本机 `~/.config/opencode/` 里的配置样例（provider / models 的真实形状）。

要更新：从源目录重新拷，不要手改。
