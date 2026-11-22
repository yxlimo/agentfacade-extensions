# 发布流程

发布只有一条路径：**打 tag，让 CI 发布**。仓库里不存任何 npm 凭据，认证只走
OIDC（npm 的 trusted publishing）。

```sh
# 1. 改版本号（三个 host 必须同版本，脚本会校验）
#    hosts/pi/package.json、hosts/opencode/package.json、hosts/dsh/package.json
# 2. 提交并推送
git commit -am "chore: bump to 0.1.2"
git push origin main

# 3. 从 main 上打 tag 并推送 —— 这一步就是发布
git tag v0.1.2
git push origin v0.1.2
```

## 四个阶段

`.github/workflows/publish.yml` 是四段式，每段职责与权限互不重叠：

| job | 做什么 | 权限 |
| --- | --- | --- |
| `verify` | 类型检查 + 全部测试；tag 与包版本对账；tag 提交必须在 `origin/main` 上；**只打包一次**，算出 sha256/sha512，产出 `identity.json` / `manifest.json` / `SHA256SUMS` | `contents: read` |
| `attest` | 只给 `.build/*.tgz` 生成 GitHub 构建证明。没有 checkout、没有包脚本、没有 npm 凭据 | `contents: read`、`id-token: write`、`attestations: write` |
| `publish` | 环境 `npm`；断言 Node ≥ 22.14.0 / npm ≥ 11.5.1；与 registry 逐字节对账后发布 verify 阶段那批 tarball；再回查 registry 完整性、provenance，并跑 `npm audit signatures` | `id-token: write`、`contents: read`、`attestations: read` |
| `release` | 用同一批产物建 GitHub release（含校验和与清单） | `contents: write` |

`publish` 阶段**绝不重新打包**：发出去的就是 `verify` 校验过的那份字节。

## 三条硬规则

1. **同版本同字节 → 跳过**。重推同一个 tag 不会报错，只是什么都不发。
2. **同版本不同字节 → 整体失败**。用同一个版本号覆盖别人已经下载到的内容，
   比发布失败危险得多；正确做法是升版本号重打 tag。
3. **只能从 `main` 的提交打 tag**。`verify` 会做祖先检查，分支上的提交直接拒绝。

## npm 侧配置（改动 workflow 时必须同步）

`publish` job 里的 `environment: npm` 不是装饰：npm 的 trusted publisher 绑定是
**仓库 + workflow 文件名 + environment** 三元组。两边不一致时 OIDC 校验失败，
发布会被拒。

每个包在 npmjs.com 的 **Settings → Trusted Publisher** 里必须填：

- Repository：`yxlimo/agentfacade-extensions`
- Workflow filename：`publish.yml`
- Environment：`npm`

改这三项中的任何一项，都要同时改 `.github/workflows/publish.yml`。

## 本地手工发布（不走 CI）

```sh
bash scripts/publish-all.sh --dry-run   # 只看会发哪些包
bash scripts/publish-all.sh             # 真发（需要 ~/.npmrc 里有 token）
```

本地没有 OIDC 身份，只能用 token；这是唯一保留凭据的场景，CI 不使用它。

## 自检

`scripts/release.mjs` 的判据有测试覆盖，不需要联网：

```sh
pnpm run test:release
```

覆盖四种情形：工具链低于下限、tag 与包版本不一致、同版本同字节跳过、
同版本异字节失败、publish 阶段缺 tarball 时报错而不是重新打包。
