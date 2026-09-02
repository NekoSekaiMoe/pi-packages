/**
 * Todo 事件处理器 — session_start / session_tree / agent_start /
 * before_agent_start / agent_end。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	migrateTodo,
	type TodoDetails,
} from "./model";
import type { TodoSessionState } from "./state";

// ── 常量 ────────────────────────────────────────────

/** 全部完成后保留的轮数，之后再自动 clear */
const AUTO_CLEAR_DELAY_ROUNDS = 2;
/** Stall 检测阈值（无 todo 活动轮数 → stall 提醒） */
const STALL_THRESHOLD = 5;
/** 提醒间隔（上次 todo 调用后轮数 → 提醒） */
const REMINDER_INTERVAL = 2;

// ── 辅助函数 ────────────────────────────────────────

export type RefreshDisplayFn = (ctx: ExtensionContext) => void;

/** 构建极简提醒：只含下一个推荐任务 */
export function buildMinimalReminder(state: TodoSessionState): string {
	const pendingTodos = state.todos.filter((t) => t.status !== "completed");
	if (pendingTodos.length === 0) return "";

	const next = pendingTodos[0];
	return `<todo_context>\n[TODO] 你有 ${pendingTodos.length} 个未完成任务。下一个应处理：#${next.id} ${next.text}\n</todo_context>`;
}

export function buildBeforeAgentStartMessage(state: TodoSessionState): { message: { customType: string; content: string; display: boolean } } | undefined {
	if (state.todos.length === 0) return undefined;

	const pendingTodos = state.todos.filter((t) => t.status !== "completed");
	if (pendingTodos.length === 0) return undefined;

	const lines = pendingTodos.map((t) => `#${t.id}: ${t.text}`);
	const contextStr =
		`<todo_context>\n[TODO] ${pendingTodos.length} tasks pending\n${lines.join("\n")}\n</todo_context>`;

	return {
		message: {
			customType: "todo-context",
			content: contextStr,
			display: false,
		},
	};
}

// ── 状态重建 ────────────────────────────────────────

export function reconstructState(state: TodoSessionState, ctx: ExtensionContext): void {
	state.todos = [];
	state.nextId = 1;
	state.userMessageCount = 0;
	state.lastTodoCallCount = 0;
	state.stallNotified = false;
	state.allCompletedAtCount = null;
	state.completionSteered = false;
	state.pendingSteerMessage = null;

	const entries = ctx.sessionManager.getEntries();
	let latestIdx = -1;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

		const details = msg.details as TodoDetails | undefined;
		if (details?.todos && Array.isArray(details.todos)) {
			state.todos = details.todos.map((t) => migrateTodo(t));
			state.nextId = details.nextId ?? (state.todos.length > 0 ? Math.max(...state.todos.map((t) => t.id)) + 1 : 1);
			latestIdx = i;
		}
	}

	if (latestIdx >= 0) {
		const staleIndices: number[] = [];
		for (let i = 0; i < latestIdx; i++) {
			const entry = entries[i];
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "todo") {
				staleIndices.push(i);
			}
		}
		for (let j = staleIndices.length - 1; j >= 0; j--) {
			entries.splice(staleIndices[j], 1);
		}
	}
}

// ── agent_end 子函数 ────────────────────────────────

export function handleAutoClear(state: TodoSessionState): { handled: boolean; cleared: boolean } {
	const allCompleted = state.todos.every((t) => t.status === "completed");
	if (!allCompleted) {
		state.allCompletedAtCount = null;
		return { handled: false, cleared: false };
	}
	if (state.allCompletedAtCount === null) {
		state.allCompletedAtCount = state.userMessageCount;
	}
	if (state.userMessageCount - state.allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS) {
		state.todos = [];
		state.nextId = 1;
		state.allCompletedAtCount = null;
		state.completionSteered = false;
		return { handled: true, cleared: true };
	}
	return { handled: true, cleared: false };
}

export function handleCompletionSteer(state: TodoSessionState): boolean {
	if (state.completionSteered) return false;
	const allCompleted = state.todos.length > 0 && state.todos.every((t) => t.status === "completed");
	if (!allCompleted) return false;

	state.completionSteered = true;
	state.pendingSteerMessage = `<todo_context>\n[TODO] 所有任务已完成。请快速检查每项任务的交付质量。\n</todo_context>`;
	return true;
}

export function handleStallDetection(state: TodoSessionState): boolean {
	if (
		!state.stallNotified &&
		state.userMessageCount - state.lastTodoCallCount >= STALL_THRESHOLD
	) {
		state.stallNotified = true;
		const reminder = buildMinimalReminder(state);
		if (reminder) {
			state.pendingSteerMessage = reminder;
		}
		return true;
	}
	return false;
}

export function handleReminder(state: TodoSessionState): boolean {
	if (state.userMessageCount - state.lastTodoCallCount >= REMINDER_INTERVAL) {
		const reminder = buildMinimalReminder(state);
		if (reminder) {
			state.pendingSteerMessage = reminder;
		}
		return true;
	}
	return false;
}

// ── Event handler 注册入口 ──────────────────────────

export function registerTodoEventHandlers(
	pi: ExtensionAPI,
	state: TodoSessionState,
	refreshDisplay: RefreshDisplayFn,
): void {
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		reconstructState(state, ctx);
		refreshDisplay(ctx);
	});
	pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
		reconstructState(state, ctx);
		refreshDisplay(ctx);
	});

	pi.on("agent_start", async (_event: unknown, _ctx: ExtensionContext) => {
		state.userMessageCount++;
	});

	pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
		try {
			const pendingTodos = state.todos.filter((t) => t.status !== "completed");
			if (pendingTodos.length > 0) {
				ctx.ui.setStatus("todo", `📋 ${pendingTodos.length} pending`);
			}
			// 优先级 1: agent_end 设置的延迟 steer
			if (state.pendingSteerMessage) {
				const msg = state.pendingSteerMessage;
				state.pendingSteerMessage = null;
				return { message: { customType: "todo-context", content: msg, display: false } };
			}

			return buildBeforeAgentStartMessage(state);
		} catch (e) {
			console.debug("[todo] before_agent_start error:", e);
			return undefined;
		}
	});

	pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
		try {
			if (state.todos.length === 0) return;

			// 全部 completed → 总检查 steer（仅一次）
			handleCompletionSteer(state);

			// auto-clear
			const ac = handleAutoClear(state);
			if (ac.handled) { if (ac.cleared) refreshDisplay(ctx); return; }

			if (handleStallDetection(state)) return;
			handleReminder(state);
		} catch (e) {
			console.debug("[todo] agent_end error:", e);
		}
	});
}
