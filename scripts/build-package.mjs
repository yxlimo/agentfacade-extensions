#!/usr/bin/env node
// 把某个 agent 的适配器打成自包含的 npm 包：host 目录 + core/，import 改指 ./core/。
//
// 为什么需要这一步：仓库里各适配器用 `../../core/x.ts` 引用共用的 core，发布出去的
// 包被装在 node_modules/<name>/ 下，那条相对路径会跑到 node_modules 外面去。所以打包时
// 把 core 复制进包内，并把引用改成 `./core/x.ts`。
//
//   node scripts/build-package.mjs pi opencode dsh
//
// 产物在 .build/<包名>-<版本>.tgz。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, ".build");
const CORE = path.join(ROOT, "core");
const SKIP = new Set(["test", "fixtures", "node_modules", "tsconfig.json", "pnpm-lock.yaml"]);

const hosts = process.argv.slice(2);
if (hosts.length === 0) {
  console.error("用法: node scripts/build-package.mjs <host>...");
  process.exit(2);
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (SKIP.has(entry)) continue;
    const src = path.join(from, entry);
    const dst = path.join(to, entry);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else cpSync(src, dst);
  }
}

// 只改 import 说明符，不碰字符串里的其他内容。
function rewriteImports(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) {
      rewriteImports(file);
      continue;
    }
    if (!file.endsWith(".ts")) continue;
    const before = readFileSync(file, "utf8");
    const after = before.replaceAll('"../../core/', '"./core/');
    if (after !== before) writeFileSync(file, after);
  }
}

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

for (const host of hosts) {
  const hostDir = path.join(ROOT, "hosts", host);
  const manifest = JSON.parse(readFileSync(path.join(hostDir, "package.json"), "utf8"));
  const staging = path.join(BUILD, host);
  copyTree(hostDir, staging);
  copyTree(CORE, path.join(staging, "core"));
  rewriteImports(staging);

  const leftovers = execFileSync("bash", ["-lc", `grep -rl '\\.\\./\\.\\./core/' ${staging} || true`], {
    encoding: "utf8",
  }).trim();
  if (leftovers) {
    console.error(`✗ ${host}: 还有指向 ../../core 的引用：\n${leftovers}`);
    process.exit(1);
  }
  // dsh 跑的是原生 node，而 node 拒绝给 node_modules 下的文件剥类型（实测：
  // "Stripping types is currently unsupported for files under node_modules"）。
  // pi 用 jiti 转译、OpenCode 基于 Bun，都能直接吃 .ts；dsh 不能，所以它发编译产物。
  if (manifest.dsh) {
    const tsconfig = path.join(staging, "tsconfig.build.json");
    writeFileSync(
      tsconfig,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            rewriteRelativeImportExtensions: true,
            strict: true,
            skipLibCheck: true,
            outDir: "dist",
          },
          include: ["*.ts", "core/**/*.ts"],
        },
        null,
        2,
      ),
    );
    execFileSync(path.join(ROOT, "node_modules", ".bin", "tsc"), ["-p", tsconfig], {
      cwd: staging,
      stdio: "inherit",
    });
    rmSync(tsconfig, { force: true });
    // 源码不进包：只留 dist，避免两份真相。
    for (const entry of readdirSync(staging)) {
      if (entry.endsWith(".ts")) rmSync(path.join(staging, entry));
    }
    rmSync(path.join(staging, "core"), { recursive: true, force: true });
    rmSync(path.join(staging, "package.json"), { force: true });
    writeFileSync(
      path.join(staging, "package.json"),
      `${JSON.stringify({ ...manifest, main: "./dist/index.js", exports: { ".": "./dist/index.js" }, files: ["dist", "cordis.patch.yml"] }, null, 2)}\n`,
    );
  }

  const out = execFileSync("npm", ["pack", "--pack-destination", BUILD], { cwd: staging, encoding: "utf8" });
  console.log(`${manifest.name}@${manifest.version} → ${path.join(BUILD, out.trim().split("\n").pop())}`);
}
