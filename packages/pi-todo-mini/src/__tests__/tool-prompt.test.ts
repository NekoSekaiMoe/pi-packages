// 提示词质量回归：todo tool 的 description 与 runtime 纠错文案必须是
// "弱模型友好"的——条件必填字段要给完整 JSON 正例，双形陷阱（text/texts、
// id/ids）要给消歧反例，失败后 throw 要带 Correct 正例让模型自我纠正。
//
// 本测试用源码文本断言锁定这些约束，防止后续重构把正例/反例/纠错文案删掉或
// 弱化。读源码而非 import，避免 mock 链（tool.ts 依赖 typebox/ExtensionAPI/
// Theme 等值导入）。参考 subagent-workflow 的 prompt 回归范式。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_SRC = readFileSync(join(__dirname, "../tool.ts"), "utf-8");

/**
 * 提取 description 拼接区（从 `description:` 到下一个 `promptSnippet:`）。
 * tool.ts 的 description 用字符串拼接（非模板字面量），故整段截取后做子串断言。
 */
function extractDescriptionRegion(src: string): string {
	// 锚定到 registerTodoTool 内的 tool description，而非 schema 字段的 description:
	// （Type.String({ description: "..." }) 等 schema 字段会先被 indexOf 命中，导致
	// 捕获区域含 schema 描述 + tool 描述——虽当前子串唯一能过但 fragile to restructuring）。
	const regIdx = src.indexOf("registerTodoTool");
	if (regIdx === -1) throw new Error("registerTodoTool not found in tool.ts");
	const start = src.indexOf("description:", regIdx);
	if (start === -1) throw new Error("tool description: not found in registerTodoTool");
	const end = src.indexOf("promptSnippet:", start);
	if (end === -1) throw new Error("promptSnippet: not found in tool.ts");
	return src.slice(start, end);
}

const DESCRIPTION_REGION = extractDescriptionRegion(TOOL_SRC);

// ── description 必须给完整 JSON 正例 ─────────────────

describe("todo description — 给完整 JSON 正例", () => {
	it("add 正例：含 {\"action\":\"add\",\"texts\"", () => {
		// 弱模型 add 时易误用单数 text；正例必须显式 texts 数组。
		expect(DESCRIPTION_REGION).toContain('{"action":"add","texts"');
	});

	it("add+verification 正例：含 isVerification", () => {
		expect(DESCRIPTION_REGION).toContain('"isVerification":true');
	});

	it("update single 正例：含 {\"action\":\"update\",\"id\"", () => {
		expect(DESCRIPTION_REGION).toContain('{"action":"update","id"');
	});

	it("update batch 正例：含 {\"action\":\"update\",\"updates\"", () => {
		// updates[] 批量路径是 [批量优先] 规范的核心，正例不可缺。
		expect(DESCRIPTION_REGION).toContain('{"action":"update","updates"');
	});

	it("delete 正例：含 {\"action\":\"delete\",\"ids\"", () => {
		// 弱模型 delete 时易误用单数 id；正例必须显式 ids 数组。
		expect(DESCRIPTION_REGION).toContain('{"action":"delete","ids"');
	});
});

// ── description 必须给双形陷阱反例（消歧） ──────────

describe("todo description — 双形陷阱反例（消歧单复数）", () => {
	it("Don't 段存在", () => {
		expect(DESCRIPTION_REGION).toMatch(/Don't/);
	});

	it("反例标注：text 属于 update（add 用 texts）", () => {
		// 反例必须含消歧词，告诉模型 text 属于 update 而非 add。
		expect(DESCRIPTION_REGION).toContain("text is for update");
		expect(DESCRIPTION_REGION).toContain("add uses texts");
	});

	it("反例标注：id 属于 update（delete 用 ids）", () => {
		expect(DESCRIPTION_REGION).toContain("id is for update");
		expect(DESCRIPTION_REGION).toContain("delete uses ids");
	});

	it("反例标注：update 缺 id", () => {
		expect(DESCRIPTION_REGION).toContain("missing id");
	});
});

// ── runtime throw 必须带 Correct 纠错正例 ───────────

describe("todo runtime — throw 含 Correct 纠错正例", () => {
	it("源码含 ≥4 处 Correct: 纠错文案（覆盖 add/delete/update 路径）", () => {
		// 每个 required throw 必须追加完整 JSON 正例，弱模型失败后能自我纠正。
		const matches = TOOL_SRC.match(/Correct:/g) || [];
		expect(matches.length).toBeGreaterThanOrEqual(4);
	});

	it('add 双形检测：含 singular "text" 纠错文案', () => {
		expect(TOOL_SRC).toContain('singular "text"');
		expect(TOOL_SRC).toContain('"text" — that field is for update');
	});

	it('delete 双形检测：含 singular "id" 纠错文案', () => {
		expect(TOOL_SRC).toContain('singular "id"');
		expect(TOOL_SRC).toContain('"id" — that field is for update');
	});
});
