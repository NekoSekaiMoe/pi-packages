/**
 * Todo tool 注册 + execute dispatcher + 5 个 action handler。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import {
	addTodos,
	buildGui,
	formatTodoLine,
	type Todo,
	type TodoDetails,
	updateTodos,
	VALID_STATUSES,
} from "./model";
import { renderTodoResult } from "./render";
import type { TodoSessionState } from "./state";

// ── Action 参数类型 ──────────────────────────────────

export interface TodoActionParams {
	action: string;
	text?: string;
	id?: number;
	texts?: string[];
	ids?: number[];
	status?: string;
	isVerification?: boolean;
	updates?: Array<{ id: number; status?: string; text?: string }>;
}

// ── TodoParams schema ────────────────────────────────

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "delete", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for update action)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for update action)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Todo text list (for add action)" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Todo ID list (for delete action)" })),
	status: Type.Optional(
			StringEnum(VALID_STATUSES, { description: "Target status (for update action)" }),
		),
	isVerification: Type.Optional(
		Type.Boolean({
			description: "Mark added todos as verification tasks (for add action). Verification todos must be completed (not cancelled) before goal completion.",
		}),
	),
	updates: Type.Optional(
			Type.Array(
				Type.Object({
					id: Type.Number({ description: "Todo ID to update" }),
					status: Type.Optional(
						Type.String({ description: "Target status; one of pending/in_progress/completed/cancelled" }),
					),
					text: Type.Optional(Type.String({ description: "New todo text" })),
				}),
				{ description: "Batch updates array (takes priority over single id/status/text)" },
			),
		),
	});

// ── 5 个 action handler ──────────────────────────────
// 错误处理约定（见 CLAUDE.md「Tool 设计」）：handler 失败直接 throw，
// 不返回「错误成功模式」。model 层纯函数返回 Result 对象（合法），
// 由 dispatcher 在拿到 error 时 throw，把友好文案交给 Pi 框架展示。

/** list action */
function handleList(state: TodoSessionState): string {
	return state.todos.length
		? state.todos.map((t) => formatTodoLine(t)).join("\n")
		: "No todos";
}

/** add action — 失败抛错 */
/** add action — 失败抛错。export 供 behavioral 测试（text/texts 双形陷阱检测）。 */
export function handleAdd(state: TodoSessionState, params: TodoActionParams): string {
	if (!params.texts || params.texts.length === 0) {
		// 双形陷阱：弱模型 add 时误用单数 text（那是 update 的字段）
		if (params.text !== undefined) {
			throw new Error(
				'add needs texts (array). You passed singular "text" — that field is for update. Correct: {"action":"add","texts":["<your text>"]}',
			);
		}
		throw new Error(
			'add requires texts parameter (non-empty array). Correct: {"action":"add","texts":["..."]}',
		);
	}
	const r = addTodos(state.todos, state.nextId, params.texts, params.isVerification);
	if (r.error) throw new Error(r.resultText);
	state.todos = r.newTodos;
	state.nextId = r.newNextId;
	return r.resultText!;
}

/** update action: batch — 失败抛错 */
function handleBatchUpdate(state: TodoSessionState, params: TodoActionParams): string {
	const r = updateTodos(state.todos, params.updates ?? []);
	if (r.error) throw new Error(r.resultText);
	state.todos = r.updatedTodos;
	return r.resultText!;
}

/** update action: single — 失败抛错 */
export function handleSingleUpdate(state: TodoSessionState, params: TodoActionParams): string {
	if (params.id === undefined)
		throw new Error(
			'update requires id parameter. Correct: {"action":"update","id":<n>,"status":"in_progress"}',
		);
	if (params.status === undefined && params.text === undefined)
		throw new Error(
			'update requires at least status or text parameter. Correct: {"action":"update","id":<n>,"status":"in_progress"}',
		);
	if (params.text !== undefined && params.text === "") throw new Error("text cannot be empty string");
	if (
		params.status !== undefined &&
		!VALID_STATUSES.includes(params.status as (typeof VALID_STATUSES)[number])
	) {
		throw new Error(`status only accepts ${VALID_STATUSES.join(" / ")}`);
	}

	const todo = state.todos.find((t) => t.id === params.id);
	if (!todo) throw new Error(`Todo #${params.id} not found`);

	// FR-6 不变量守卫（失败抛错）：(a) cancelled 不可恢复；(b) 验证任务不可 cancelled
	if (todo.status === "cancelled" && params.status !== undefined) {
		throw new Error(`#${params.id} is cancelled (cannot restore)`);
	}
	if (todo.isVerification && params.status === "cancelled") {
		throw new Error(`#${params.id} is verification todo (cannot cancel)`);
	}

	if (params.status !== undefined) todo.status = params.status as Todo["status"];
	if (params.text !== undefined) todo.text = params.text;

	const parts: string[] = [`Updated todo #${todo.id}`];
	if (params.status !== undefined) parts.push(`status → ${params.status}`);
	if (params.text !== undefined) parts.push(`text → "${todo.text}"`);

	// 最后一个完成提示
	const incompleteAfter = state.todos.filter((t) => t.status !== "completed");
	if (params.status === "completed" && incompleteAfter.length === 0) {
		return parts.join(", ") + "\n\nAll todos completed. Please summarize your work.";
	}
	return parts.join(", ");
}

/** update action: dispatcher — batch 优先于 single */
function handleUpdate(state: TodoSessionState, params: TodoActionParams): string {
	if (params.updates && params.updates.length > 0) return handleBatchUpdate(state, params);
	return handleSingleUpdate(state, params);
}

/** delete action — 失败抛错；部分 id 缺失则整体拒绝（原子性） */
/** delete action — 失败抛错。export 供 behavioral 测试（id/ids 双形陷阱检测）。 */
export function handleDelete(state: TodoSessionState, params: TodoActionParams): string {
	if (!params.ids || params.ids.length === 0) {
		// 双形陷阱：弱模型 delete 时误用单数 id（那是 update 的字段）
		if (params.id !== undefined) {
			throw new Error(
				'delete needs ids (array). You passed singular "id" — that field is for update. Correct: {"action":"delete","ids":[<your id>]}',
			);
		}
		throw new Error(
			'delete requires ids parameter (non-empty array). Correct: {"action":"delete","ids":[<n>]}',
		);
	}
	const uniqueIds = [...new Set(params.ids)];
	const missing = uniqueIds.filter((id) => !state.todos.some((t) => t.id === id));
	if (missing.length > 0) {
		throw new Error(`Todo #${missing.join(", #")} not found`);
	}
	const removedIds: number[] = [];
	for (const id of uniqueIds) {
		const idx = state.todos.findIndex((t) => t.id === id);
		if (idx !== -1) {
			state.todos.splice(idx, 1);
			removedIds.push(id);
		}
	}
	return `Deleted ${removedIds.length} items (#${removedIds.join(", #")}), ${state.todos.length} remaining`;
}

/** clear action */
function handleClear(state: TodoSessionState): string {
	const count = state.todos.length;
	state.todos = [];
	state.nextId = 1;
	state.allCompletedAtCount = null;
	state.completionSteered = false;
	return count > 0 ? `Cleared ${count} todos` : "No todos to clear";
}

// ── Dispatcher ───────────────────────────────────────

function executeTodoAction(
	params: TodoActionParams,
	state: TodoSessionState,
	ctx: ExtensionContext,
	refreshDisplay: (ctx: ExtensionContext) => void,
): {
	content: Array<{ type: "text"; text: string }>;
	details: TodoDetails;
} {
	state.lastTodoCallCount = state.userMessageCount;
	state.stallNotified = false;

	let resultText: string;
	switch (params.action) {
		case "list":
			resultText = handleList(state);
			break;
		case "add":
			resultText = handleAdd(state, params);
			break;
		case "update":
			resultText = handleUpdate(state, params);
			break;
		case "delete":
			resultText = handleDelete(state, params);
			break;
		case "clear":
			resultText = handleClear(state);
			break;
		default:
			throw new Error(`Unknown action: ${params.action}`);
	}

	refreshDisplay(ctx);

	const details: TodoDetails = {
		action: params.action as TodoDetails["action"],
		todos: [...state.todos],
		nextId: state.nextId,
	};
	// RPC 模式（xyz-agent GUI）附加 __gui__，前端按 list-tree 渲染。
	// TUI/print/json 模式走原生文本渲染（resultText 已在 content 中）。
	if (ctx.mode === "rpc") {
		details.__gui__ = buildGui(state.todos);
	}
	return {
		content: [{ type: "text" as const, text: resultText }],
		details,
	};
}

// ── Tool 注册入口 ─────────────────────────────────────

export function registerTodoTool(
	pi: ExtensionAPI,
	state: TodoSessionState,
	refreshDisplay: (ctx: ExtensionContext) => void,
): void {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			'Manage the session todo list. statuses: pending | in_progress | completed | cancelled.\n' +
			'Examples: add {"action":"add","texts":["write tests","run typecheck"]} · verification add {"action":"add","texts":["run yarn test"],"isVerification":true}\n' +
			'update single {"action":"update","id":2,"status":"in_progress"} or {"action":"update","id":2,"text":"reworded"} · update batch (takes priority) {"action":"update","updates":[{"id":1,"status":"completed"},{"id":3,"text":"reworded"}]}\n' +
			'delete {"action":"delete","ids":[1,3]} · list {"action":"list"} · clear {"action":"clear"}\n' +
			"Don't: pass singular \"text\" to add — text is for update, add uses texts[]. " +
			"Don't: pass singular \"id\" to delete — id is for update, delete uses ids[]. " +
			"Don't: update with missing id — id is required.",
		promptSnippet: "Use todo when breaking multi-step work into trackable items. Add verification todos (isVerification=true) for checks like running tests.",
		promptGuidelines: [
			"Break multi-step work (3+ steps) into todos; create verification todos (isVerification) for checks like running tests; batch-update via updates[].",
		],
		executionMode: "sequential",
		parameters: TodoParams,

		async execute(_toolCallId: string, params: Static<typeof TodoParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			if (signal?.aborted) throw new Error("Todo call aborted by signal.");
			return executeTodoAction(params as TodoActionParams, state, ctx, refreshDisplay);
		},

		renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action as string);
			const texts = args.texts as string[] | undefined;
			const ids = args.ids as number[] | undefined;
			if (texts && texts.length > 0) text += ` ${theme.fg("dim", `(${texts.length} items)`)}`;
			if (ids && ids.length > 0) text += ` ${theme.fg("accent", `#${ids.join(", #")}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.status) text += ` ${theme.fg("warning", args.status as string)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: unknown, options: { expanded: boolean }, theme: Theme, _context?: unknown) {
			return renderTodoResult(result, options, theme);
		},
	});
}
