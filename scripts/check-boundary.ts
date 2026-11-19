// 边界检查：宿主层不许知道网关报文长什么样。
//
// 这条规则来自一个真实的返工：网关把 /v1/models 从 anthropic 渲染换成 openai 渲染时，
// 生产代码只有 core/catalog.ts 一处要改 —— 但 `hosts/*/fixtures/gateway-v1-models.json`
// 与 `hosts/dsh/test/check.ts` 里各自存了一份报文，于是三个宿主都得跟着改一遍。
// 「core 只有一个地方认识网关」这条分层，靠自觉守不住：谁在宿主里写一次 `display_name`，
// 规则就破一次且没人会发现。所以这里用扫描把它变成会红的检查。
//
// 只扫宿主的**生产源码**（*.ts，排除 test/ 与 fixtures/）：
// 宿主测试通过假网关走的是完整的 fetch → core → ModelSpec 链路，那里的报文是输入数据，
// 不是宿主对协议的认知。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOSTS_DIR = path.join(ROOT, "hosts");

/** 网关协议与 core 归一化的词汇。宿主只该看见 ModelSpec 的字段名 */
const PROTOCOL_WORDS = [
	"/v1/models",
	"display_name",
	"context_window",
	"max_output_tokens",
	"effort_options",
	"dialect=",
	"text.input.price",
	"capabilities.reasoning",
	"capabilities.tools",
	"limit.context",
	"limit.output",
];

/** 写文件的 API 一个都不许有：注册必须是运行时的，用户的配置只能由用户自己改 */
const WRITE_WORDS = [
	"writeFile",
	"appendFile",
	"createWriteStream",
	"mkdirSync",
	"unlinkSync",
	"renameSync",
	"copyFileSync",
	"truncate",
	"configEditor",
];

/**
 * 把注释剥掉，只留代码。
 *
 * 注释里写「网关的档位字段是 `capabilities.reasoning.effort`」是**解释**，不是越界 ——
 * 宿主作者需要知道自己在映射什么。真正要抓的是把它写进代码去取值。
 * 顺手跳过字符串字面量：URL 里的 `//` 会被当成行注释，那样会把同一行后半段的真实越界藏起来。
 */
function codeOnly(text: string): string {
	const out: string[] = [];
	let quote: string | null = null;
	let lineComment = false;
	let blockComment = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (lineComment) {
			if (ch === "\n") {
				lineComment = false;
				out.push(ch);
			}
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote !== null) {
			out.push(ch);
			if (ch === "\\") {
				out.push(String(text[i + 1] ?? ""));
				i++;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			out.push(ch);
			continue;
		}
		if (ch === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		out.push(ch);
	}
	return out.join("");
}

function sourcesOf(hostDir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path.join(hostDir, entry.name));
	}
	return out.sort((a, b) => a.localeCompare(b));
}

const failures: string[] = [];
const hosts = fs.readdirSync(HOSTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

for (const host of hosts) {
	const files = sourcesOf(path.join(HOSTS_DIR, host));
	if (files.length === 0) {
		failures.push(`${host}: 没有找到任何生产源码（扫描本身失效了，不是通过）`);
		continue;
	}
	for (const file of files) {
		const text = fs.readFileSync(file, "utf8");
		// 只看代码：注释里解释网关字段名是允许的，写进代码取值才是越界
		const code = codeOnly(text);
		const where = `${path.relative(ROOT, file)}`;
		for (const word of PROTOCOL_WORDS) {
			if (code.includes(word)) failures.push(`${where}: 出现网关协议词汇 "${word}" —— 报文形状只能住在 core`);
		}
		for (const word of WRITE_WORDS) {
			if (code.includes(word)) failures.push(`${where}: 出现写文件 API "${word}" —— 配置只能由宿主自己的运行时接口写`);
		}
	}
	// 正控：确认真的扫到了内容，否则「零命中」可能只是没匹配上任何文件
	const total = files.reduce((sum, file) => sum + fs.readFileSync(file, "utf8").length, 0);
	if (total < 200) failures.push(`${host}: 只扫到 ${total} 个字符，扫描不可信`);
	console.log(`  ok   ${host}: 扫了 ${files.length} 个源文件、${total} 个字符，无越界词汇`);
}

if (failures.length > 0) {
	console.log("");
	for (const line of failures) console.log(`  FAIL ${line}`);
	console.log(`\n${failures.length} 条越界，${hosts.length} 个宿主`);
	process.exit(1);
}
console.log(`\n全部通过（${hosts.length} 个宿主）`);
