/**
 * executeTodoAction handler 级测试 —— 覆盖 `if (ctx.mode === "rpc")` 分支
 * 和非 RPC 模式不附加 __gui__ 的路径。对齐 ask-user R-1~R-7 handler 级范式。
 *
 * 策略：executeTodoAction 未导出，通过 registerTodoTool + mock pi 捕获
 * 已注册 tool，再以不同 ctx.mode 调 execute。每个用例新建 state（隔离），
 * 无模块级状态需重置。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createTodoSessionState, type TodoSessionState } from "../state";
import { registerTodoTool } from "../tool";

// ── Types for the registered tool ───────────────────────
type TestMode = "tui" | "rpc" | "json" | "print";

interface ExecuteResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		action: string;
		todos: Array<{ id: number; text: string; status: string; isVerification?: boolean }>;
		nextId: number;
		__gui__?: {
			v: number;
			component: { type: string; props: { items: unknown[] } };
		};
	};
}

interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { mode: TestMode },
	) => Promise<ExecuteResult>;
}

// pi-coding-agent 的 ExtensionContext 类型声明里没有 mode 字段（运行时实际有），
// 与 extension-protocol 的 GuiContext 结构化兼容。这里做最小 mock 并断言。
interface MockPi {
	tool?: RegisteredTool;
	registerTool(tool: RegisteredTool): void;
}

/** 捕获注册的 tool，返回 + 暴露 state 供断言。 */
function setup(): { tool: RegisteredTool; state: TodoSessionState } {
	const state = createTodoSessionState();
	const pi: MockPi = {
		registerTool(tool) {
			this.tool = tool;
		},
	};
	registerTodoTool(pi as unknown as ExtensionAPI, state, () => {});
	if (!pi.tool) throw new Error("registerTodoTool did not register a tool");
	return { tool: pi.tool, state };
}

// ── Theme passthrough（与 todo.test.ts mockTheme 一致） ──
const stubTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
	getFgAnsi: (_color: string) => "",
	getBgAnsi: (_color: string) => "",
	getColorMode: () => "truecolor" as const,
	getThinkingBorderColor: () => (text: string) => text,
	getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme;

/** RPC 模式 ctx：hasUI=false，refreshDisplay 调用 ui.theme/setStatus/setWidget。 */
const makeRpcCtx = () => ({
	mode: "rpc" as const,
	hasUI: false,
	ui: {
		theme: stubTheme,
		setStatus: () => {},
		setWidget: () => {},
	},
});

/** TUI 模式 ctx：hasUI=true。 */
const makeTuiCtx = () => ({
	mode: "tui" as const,
	hasUI: true,
	ui: {
		theme: stubTheme,
		setStatus: () => {},
		setWidget: () => {},
	},
});

// ── RPC 模式：附加 __gui__ ────────────────────────────

describe("executeTodoAction — RPC mode attaches __gui__", () => {
	it("R-1: rpc + add → details.__gui__ exists, type is list-tree", async () => {
		const { tool } = setup();
		const result = await tool.execute(
			"id",
			{ action: "add", texts: ["task A", "task B"] },
			undefined,
			undefined,
			makeRpcCtx(),
		);
		expect(result.details.__gui__).toBeDefined();
		expect(result.details.__gui__!.v).toBe(1);
		expect(result.details.__gui__!.component.type).toBe("list-tree");
		// 两条新增 todo 反映在 items 中
		const items = result.details.__gui__!.component.props.items as Array<{
			label: string;
			icon: string;
		}>;
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ label: "#1: task A", icon: "dot" });
		expect(items[1]).toMatchObject({ label: "#2: task B", icon: "dot" });
	});

	it("R-2: rpc + list → __gui__ reflects current todo state", async () => {
		const { tool, state } = setup();
		// 预置状态（绕开 add，直接构造 todos）
		state.todos = [
			{ id: 1, text: "pending task", status: "pending" },
			{ id: 2, text: "active task", status: "in_progress" },
			{ id: 3, text: "done task", status: "completed" },
		];
		state.nextId = 4;
		const result = await tool.execute(
			"id",
			{ action: "list" },
			undefined,
			undefined,
			makeRpcCtx(),
		);
		expect(result.details.__gui__).toBeDefined();
		expect(result.details.__gui__!.component.type).toBe("list-tree");
		const items = result.details.__gui__!.component.props.items as Array<{
			label: string;
			icon: string;
			status?: string;
		}>;
		expect(items).toHaveLength(3);
		// pending → dot 无 status
		expect(items[0]).toMatchObject({ label: "#1: pending task", icon: "dot" });
		expect(items[0]).not.toHaveProperty("status");
		// in_progress → circle / running
		expect(items[1]).toMatchObject({
			label: "#2: active task",
			icon: "circle",
			status: "running",
		});
		// completed → check / done
		expect(items[2]).toMatchObject({
			label: "#3: done task",
			icon: "check",
			status: "done",
		});
	});

	it("R-3: rpc + update → __gui__ reflects post-update status", async () => {
		const { tool, state } = setup();
		state.todos = [{ id: 1, text: "item", status: "pending" }];
		state.nextId = 2;
		const result = await tool.execute(
			"id",
			{ action: "update", updates: [{ id: 1, status: "in_progress" }] },
			undefined,
			undefined,
			makeRpcCtx(),
		);
		expect(result.details.__gui__).toBeDefined();
		const items = result.details.__gui__!.component.props.items as Array<{
			icon: string;
			status?: string;
		}>;
		expect(items[0]).toMatchObject({ icon: "circle", status: "running" });
	});
});

// ── TUI 模式：不附加 __gui__ ──────────────────────────

describe("executeTodoAction — non-RPC modes omit __gui__", () => {
	it("T-1: tui + add → details.__gui__ is undefined", async () => {
		const { tool } = setup();
		const result = await tool.execute(
			"id",
			{ action: "add", texts: ["task A"] },
			undefined,
			undefined,
			makeTuiCtx(),
		);
		expect(result.details.__gui__).toBeUndefined();
		// details 仍带原生文本路径数据（todos / nextId）
		expect(result.details.todos).toHaveLength(1);
		expect(result.content[0].text).toContain("Added");
	});

	it("T-2: tui + list → details.__gui__ is undefined", async () => {
		const { tool, state } = setup();
		state.todos = [{ id: 1, text: "x", status: "pending" }];
		state.nextId = 2;
		const result = await tool.execute(
			"id",
			{ action: "list" },
			undefined,
			undefined,
			makeTuiCtx(),
		);
		expect(result.details.__gui__).toBeUndefined();
		// 文本内容仍可读
		expect(result.content[0].text).toContain("#1");
	});

	it("T-3: print mode + add → details.__gui__ is undefined", async () => {
		const { tool } = setup();
		const result = await tool.execute(
			"id",
			{ action: "add", texts: ["task A"] },
			undefined,
			undefined,
			{ mode: "print", hasUI: false, ui: { theme: stubTheme, setStatus: () => {}, setWidget: () => {} } },
		);
		expect(result.details.__gui__).toBeUndefined();
	});

	it("T-4: json mode + add → details.__gui__ is undefined", async () => {
		const { tool } = setup();
		const result = await tool.execute(
			"id",
			{ action: "add", texts: ["task A"] },
			undefined,
			undefined,
			{ mode: "json", hasUI: false, ui: { theme: stubTheme, setStatus: () => {}, setWidget: () => {} } },
		);
		expect(result.details.__gui__).toBeUndefined();
	});
});

// ── 共享 state：rpc 附加但 details.todos 是快照副本 ────

describe("executeTodoAction — state isolation & snapshot", () => {
	it("S-1: each setup() yields independent state (no module-level leak)", async () => {
		const { tool: tool1 } = setup();
		await tool1.execute("id", { action: "add", texts: ["first"] }, undefined, undefined, makeRpcCtx());
		// 第二个 setup 起步，不应看到第一个的 todos
		const { tool: tool2, state: state2 } = setup();
		expect(state2.todos).toHaveLength(0);
		const result = await tool2.execute(
			"id",
			{ action: "list" },
			undefined,
			undefined,
			makeRpcCtx(),
		);
		expect(result.content[0].text).toBe("No todos");
		// 空 list 仍走 buildGui([])（rpc 分支无条件 attach）
		expect(result.details.__gui__).toBeDefined();
		expect(result.details.__gui__!.component.props.items).toEqual([]);
	});

	it("S-2: details.todos is a shallow array copy (splice-safe, element-shared)", async () => {
		// executeTodoAction 用 [...state.todos] 做浅拷贝：数组独立、元素共享。
		// add/clear 改数组长度时旧 details.todos 不受影响；但原地改元素会共享。
		const { tool } = setup();
		await tool.execute("id", { action: "add", texts: ["a", "b"] }, undefined, undefined, makeRpcCtx());
		const before = (await tool.execute(
			"id",
			{ action: "list" },
			undefined,
			undefined,
			makeRpcCtx(),
		)).details.todos;
		expect(before).toHaveLength(2);
		// clear 改 state.todos 数组，已发出的 before 快照仍为 2 项
		await tool.execute("id", { action: "clear" }, undefined, undefined, makeRpcCtx());
		expect(before).toHaveLength(2);
	});
});
