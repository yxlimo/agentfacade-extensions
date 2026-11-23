#!/usr/bin/env node
// release.mjs 的判据测试。不依赖外网：假 registry 是本进程内的 http 服务，
// 覆盖「版本不存在 → 发布」「同版本同字节 → 跳过」「同版本异字节 → 失败」三支。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	assertToolchain,
	classifyAgainstRegistry,
	compareVersions,
	fileDigests,
	publishCheck,
	registryCheck,
	ReleaseError,
	resolveTag,
} from "./release.mjs";

// 工具链版本由用例注入：CI runner 自带 npm 可能低于 trusted publishing 的
// 下限（实测 GitHub runner 上是 npm 10.9.9），让 publishCheck 读环境里的 npm
// 会让这几条用例随宿主变化而红——判据没错，是输入不该是环境。
const TOOLCHAIN = { node: "24.0.0", npm: "11.20.0" };

// 用例自己所在目录：workflow 守卫要沿着它往上找 .github/。
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---- 工具链下限 ---------------------------------------------------------------
test("Node/npm 低于下限时报错，等于或高于则通过", () => {
	assert.throws(() => assertToolchain({ node: "22.13.9", npm: "11.5.1" }), /Node 22\.13\.9 低于下限/);
	assert.throws(() => assertToolchain({ node: "22.14.0", npm: "11.5.0" }), /npm 11\.5\.0 低于下限/);
	// 下限本身必须通过：把边界写成 > 而不是 >= 的话这里会红。
	assert.deepEqual(assertToolchain({ node: "22.14.0", npm: "11.5.1" }), { node: "22.14.0", npm: "11.5.1" });
	assert.deepEqual(assertToolchain({ node: "24.1.0", npm: "11.6.2" }), { node: "24.1.0", npm: "11.6.2" });
});

test("版本比较把预发布排在正式版之前", () => {
	assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
	assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
	assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
	assert.equal(compareVersions("1.2.3", "1.10.0"), -1);
});

// ---- tag 与包版本对账 ---------------------------------------------------------
test("tag 与包版本不一致时拒绝发布", () => {
	const targets = [{ name: "pi-agentfacade", version: "0.1.1" }];
	assert.equal(resolveTag("v0.1.1", targets), "0.1.1");
	assert.throws(() => resolveTag("v0.1.2", targets), /tag v0\.1\.2 与包版本 0\.1\.1 不一致/);
	assert.throws(() => resolveTag("0.1.1", targets), /tag 必须是 v<版本> 形式/);
	assert.throws(() => resolveTag("release-0.1.1", targets), /tag 必须是 v<版本> 形式/);
});

test("多包版本不一致时无法用单个 tag 表达", () => {
	const targets = [
		{ name: "a", version: "0.1.1" },
		{ name: "b", version: "0.1.2" },
	];
	assert.throws(() => resolveTag("v0.1.1", targets), /各包版本不一致/);
});

// ---- 假 registry -------------------------------------------------------------
// 起一个只认一个包名的 registry：返回值由测试注入。
function startRegistry(payloadFor) {
	const server = createServer((req, res) => {
		const name = decodeURIComponent((req.url ?? "/").replace(/^\//, ""));
		const payload = payloadFor(name);
		if (!payload) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(payload));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
		});
	});
}

function metadataFor(name, version, integrity) {
	return {
		name,
		"dist-tags": { latest: version },
		versions: {
			[version]: {
				name,
				version,
				dist: { integrity, ...(integrity ? {} : {}) },
			},
		},
	};
}

// 造一个真实 tarball + 一个只含该包的假仓库根，供 publishCheck 使用。
function makeFixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "agentfacade-release-"));
	const pkgDir = path.join(dir, "fixture-pkg");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(
		path.join(pkgDir, "package.json"),
		`${JSON.stringify({ name: "fixture-pkg", version: "1.2.3", files: ["index.js"] }, null, 2)}\n`,
	);
	writeFileSync(path.join(pkgDir, "index.js"), "export const ok = true;\n");
	const buildDir = path.join(dir, ".build");
	mkdirSync(buildDir, { recursive: true });
	execFileSync("npm", ["pack", "--pack-destination", buildDir, "--silent"], { cwd: pkgDir, stdio: "pipe" });
	const tarball = path.join(buildDir, "fixture-pkg-1.2.3.tgz");
	// publishCheck 从 hosts/*/package.json 读发布目标。
	mkdirSync(path.join(dir, "hosts", "pi"), { recursive: true });
	writeFileSync(
		path.join(dir, "hosts", "pi", "package.json"),
		`${JSON.stringify({ name: "fixture-pkg", version: "1.2.3" }, null, 2)}\n`,
	);
	return { dir, buildDir, tarball, integrity: fileDigests(tarball).integrity };
}

test("同版本已存在且字节相同 → 跳过，不重复发布", async () => {
	const fixture = makeFixture();
	const registry = await startRegistry(() => metadataFor("fixture-pkg", "1.2.3", fixture.integrity));
	try {
		const verdict = await classifyAgainstRegistry({
			name: "fixture-pkg",
			version: "1.2.3",
			integrity: fixture.integrity,
			registry: registry.url,
		});
		assert.equal(verdict.state, "identical");

		const result = await publishCheck({ tag: "v1.2.3", root: fixture.dir, artifactDir: fixture.buildDir, registry: registry.url, toolchain: TOOLCHAIN });
		assert.deepEqual(result.decisions, [{ name: "fixture-pkg", file: "fixture-pkg-1.2.3.tgz", publish: false, state: "identical" }]);
	} finally {
		registry.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("同版本已存在但字节不同 → 失败并给出两份指纹", async () => {
	const fixture = makeFixture();
	const registry = await startRegistry(() => metadataFor("fixture-pkg", "1.2.3", "sha512-differentBytesOnTheRegistry=="));
	try {
		const verdict = await classifyAgainstRegistry({
			name: "fixture-pkg",
			version: "1.2.3",
			integrity: fixture.integrity,
			registry: registry.url,
		});
		assert.equal(verdict.state, "conflict");

		await assert.rejects(
			() => publishCheck({ tag: "v1.2.3", root: fixture.dir, artifactDir: fixture.buildDir, registry: registry.url, toolchain: TOOLCHAIN }),
			(error) => {
				assert.ok(error instanceof ReleaseError, "必须是面向使用者的失败，而不是崩溃");
				assert.match(error.message, /1 个包的版本已在 registry 上但字节不同/);
				assert.match(error.message, /sha512-differentBytesOnTheRegistry==/);
				assert.match(error.message, /提升版本号/);
				return true;
			},
		);
	} finally {
		registry.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("版本不存在 → 允许发布", async () => {
	const fixture = makeFixture();
	// 404 分支：registry 上完全没有这个包。
	const registry = await startRegistry(() => null);
	try {
		const result = await publishCheck({ tag: "v1.2.3", root: fixture.dir, artifactDir: fixture.buildDir, registry: registry.url, toolchain: TOOLCHAIN });
		assert.deepEqual(result.decisions, [{ name: "fixture-pkg", file: "fixture-pkg-1.2.3.tgz", publish: true, state: "absent" }]);
	} finally {
		registry.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("publish 阶段缺少 tarball 时报错，不重新打包", async () => {
	const fixture = makeFixture();
	const registry = await startRegistry(() => null);
	rmSync(fixture.tarball);
	try {
		await assert.rejects(
			() => publishCheck({ tag: "v1.2.3", root: fixture.dir, artifactDir: fixture.buildDir, registry: registry.url, toolchain: TOOLCHAIN }),
			/publish 阶段不允许重新打包/,
		);
	} finally {
		registry.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

// workflow 的产物目录以点开头（`.build/`），upload-artifact 默认跳过隐藏路径：
// verify 全过、artifact 空、下游 job 拿不到 tarball，而报错只说「No files were found」。
test("隐藏的产物目录必须显式允许上传隐藏文件", () => {
	const workflow = readFileSync(path.join(SCRIPT_ROOT, "..", ".github", "workflows", "publish.yml"), "utf8");
	const steps = workflow.split("- uses: actions/upload-artifact@").slice(1);
	assert.ok(steps.length > 0, "publish.yml 里没有 upload-artifact 步骤，这条用例失去意义");

	for (const [index, block] of steps.entries()) {
		const step = block.split("- uses:")[0];
		const pathLine = /^\s*path:\s*(\S+)/m.exec(step);
		assert.ok(pathLine, `第 ${index + 1} 个 upload-artifact 步骤没有 path`);
		const artifactPath = pathLine[1].replace(/\/+$/, "");
		const hidden = path.basename(artifactPath).startsWith(".");
		const allowed = /^\s*include-hidden-files:\s*true\s*$/m.test(step);
		assert.equal(
			allowed,
			hidden,
			hidden
				? `产物路径 ${artifactPath} 是隐藏目录，必须 include-hidden-files: true`
				: `产物路径 ${artifactPath} 不是隐藏目录，别开 include-hidden-files`,
		);
	}
});

// 发布是异步的：npm 打完 `+ pkg@版本` 之后元数据可能还没传播，一次查询会把成功的发布判成失败。
test("registry 元数据晚到 → 等它出现，不判失败", async () => {
	const fixture = makeFixture();
	const metadata = {
		name: "fixture-pkg",
		"dist-tags": { latest: "1.2.3" },
		versions: {
			"1.2.3": {
				name: "fixture-pkg",
				version: "1.2.3",
				dist: {
					integrity: fixture.integrity,
					attestations: { provenance: { url: "https://example.invalid/provenance" } },
				},
			},
		},
	};
	let calls = 0;
	const registry = await startRegistry(() => {
		calls += 1;
		return calls < 3 ? null : metadata;
	});
	try {
		const result = await registryCheck({
			tag: "v1.2.3",
			root: fixture.dir,
			artifactDir: fixture.buildDir,
			registry: registry.url,
			audit: false,
			waitMs: 5_000,
			intervalMs: 5,
		});
		assert.equal(result.results.length, 1, "等到之后应当核对通过");
		assert.ok(calls >= 3, `应当重试到第 3 次，实际查了 ${calls} 次`);
	} finally {
		registry.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("registry 始终没有该版本 → 报出等了多久、查了几次", async () => {
	const fixture = makeFixture();
	const registry = await startRegistry(() => null);
	try {
		await assert.rejects(
			() =>
				registryCheck({
					tag: "v1.2.3",
					root: fixture.dir,
					artifactDir: fixture.buildDir,
					registry: registry.url,
					audit: false,
					waitMs: 60,
					intervalMs: 5,
				}),
			(error) => {
				assert.ok(error instanceof ReleaseError, "必须是面向使用者的失败，而不是崩溃");
				assert.match(error.message, /不在 registry 上：等了 .* 次仍未生效/);
				return true;
			},
		);
	} finally {
		registry.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});
