/**
 * dsh-profile-context-lite —— 补上 `profileContext` 服务。
 *
 * 为什么需要它
 * ------------
 * `@deepseek-ai/dsh-settings` 的服务类声明 `static inject = ["configEditor", "profileContext"]`，
 * 而 `configEditor` 又 inject `["loader", "profileContext"]`。inject 依赖等不到时，
 * Cordis 不会构造该服务（**不报错、不打日志**），于是：
 *   - `settings` 服务缺席 → dsh-lark-channel 的 /model 切换、/cd 工作区只活内存
 *     （插件日志："model switches are in-memory only (no settings service)"）；
 *   - 官方的 `@deepseek-ai/dsh-settings` 包虽随镜像存在，但**不是 bundle**
 *     （package.json 无 dsh.bundle），而 bundle 只能从 dsh 安装目录解析（容器里只读），
 *     所以无法用"加 bundle"的方式启用它。
 *
 * 本包以本地 link 依赖装进 profile，自带 dsh.bundle 声明，因此能进 bundle 列表，
 * 并在插件作用域内 provide 一个 profileContext —— 让 configEditor / settings 两个
 * 服务的 inject 依赖得到满足，官方实现即可正常工作。
 *
 * 提供的字段与 dsh 内部 profile-boot 构造的一致（name/dir/patchPath/installAnchor/
 * startedBundles/cwd/home/overlays/telemetryDisabledEnv）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const name = "dsh-profile-context-lite";

function resolveHome() {
  return process.env.DSH_HOME ?? "/home/node/.dsh";
}

function resolveProfileDir(ctx) {
  const fromContext = ctx.get("profileContext")?.dir;
  if (typeof fromContext === "string" && fromContext.length > 0) return fromContext;
  const profile = process.env.DSH_PROFILE ?? "web";
  return join(resolveHome(), "profiles", profile);
}

export function apply(ctx) {
  // 已经能拿到真的 profileContext 就不插手（避免遮蔽上游实现）
  if (ctx.get("profileContext") !== undefined) {
    ctx.logger.info("profile-context-lite: upstream profileContext already present; no-op");
    return;
  }

  const home = resolveHome();
  const dir = resolveProfileDir(ctx);
  const patchPath = join(dir, "cordis.patch.yml");
  const installAnchor = "/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json";

  const profileContext = {
    name: process.env.DSH_PROFILE ?? "web",
    dir,
    patchPath: existsSync(patchPath) ? patchPath : undefined,
    installAnchor: existsSync(installAnchor) ? installAnchor : undefined,
    startedBundles: [],
    cwd: process.cwd(),
    home,
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  };

  ctx.provide("profileContext", profileContext);
  ctx.logger.info("profile-context-lite: provided profileContext (dir: %s)", dir);
}
