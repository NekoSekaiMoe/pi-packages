import { describe, expect, it } from "vitest";

import {
	buildBeforeAgentStartMessage,
	buildMinimalReminder,
	handleAutoClear,
	handleCompletionSteer,
	handleReminder,
	handleStallDetection,
	reconstructState,
} from "../handlers";
import type { Todo } from "../model";
import { createTodoSessionState, type TodoSessionState } from "../state";

// ── helpers ─────────────────────────────────────────

function makeState(todos: Todo[], overrides: Partial<TodoSessionState> = {}): TodoSessionState {
	const s = createTodoSessionState();
	s.todos = todos;
	Object.assign(s, overrides);
	return s;
}

function todoEntry(todos: Todo[], nextId: number) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "todo", details: { todos, nextId } },
	};
}

function makeCtx(entries: unknown[]) {
	return {
		sessionManager: { getEntries: () => entries },
	} as unknown as Parameters<typeof reconstructState>[1];
}

// ── completion steer ────────────────────────────────

describe("handleCompletionSteer", () => {
	it("sets one-shot steer when all completed", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }]);
		expect(handleCompletionSteer(s)).toBe(true);
		expect(s.completionSteered).toBe(true);
		expect(s.pendingSteerMessage).toContain("交付质量");
	});

	it("does not steer twice (single-shot lock)", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], { completionSteered: true });
		expect(handleCompletionSteer(s)).toBe(false);
		expect(s.pendingSteerMessage).toBeNull();
	});

	it("does not steer when not all completed", () => {
		const s = makeState([
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "pending" },
		]);
		expect(handleCompletionSteer(s)).toBe(false);
		expect(s.completionSteered).toBe(false);
	});

	it("does not steer on empty list", () => {
		expect(handleCompletionSteer(makeState([]))).toBe(false);
	});
});

// ── auto-clear ──────────────────────────────────────

describe("handleAutoClear", () => {
	it("does not handle when not all completed, and resets anchor", () => {
		const s = makeState([{ id: 1, text: "a", status: "pending" }], { allCompletedAtCount: 3 });
		expect(handleAutoClear(s)).toEqual({ handled: false, cleared: false });
		expect(s.allCompletedAtCount).toBeNull();
	});

	it("anchors on first all-completed round without clearing", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], { userMessageCount: 5 });
		expect(handleAutoClear(s)).toEqual({ handled: true, cleared: false });
		expect(s.allCompletedAtCount).toBe(5);
		expect(s.todos).toHaveLength(1);
	});

	it("does not clear before AUTO_CLEAR_DELAY_ROUNDS (2) elapse", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], {
			userMessageCount: 5, allCompletedAtCount: 4,
		});
		expect(handleAutoClear(s)).toEqual({ handled: true, cleared: false });
	});

	it("clears and resets flags after delay elapses", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], {
			userMessageCount: 6, allCompletedAtCount: 4, completionSteered: true,
		});
		expect(handleAutoClear(s)).toEqual({ handled: true, cleared: true });
		expect(s.todos).toEqual([]);
		expect(s.nextId).toBe(1);
		expect(s.allCompletedAtCount).toBeNull();
		expect(s.completionSteered).toBe(false);
	});
});

// ── stall detection ─────────────────────────────────

describe("handleStallDetection", () => {
	it("fires once when idle exceeds STALL_THRESHOLD (5)", () => {
		const s = makeState([{ id: 1, text: "task", status: "pending" }], {
			userMessageCount: 10, lastTodoCallCount: 5,
		});
		expect(handleStallDetection(s)).toBe(true);
		expect(s.stallNotified).toBe(true);
		expect(s.pendingSteerMessage).toContain("#1");
	});

	it("does not fire twice (single-shot lock)", () => {
		const s = makeState([{ id: 1, text: "task", status: "pending" }], {
			userMessageCount: 10, lastTodoCallCount: 5, stallNotified: true,
		});
		expect(handleStallDetection(s)).toBe(false);
		expect(s.pendingSteerMessage).toBeNull();
	});

	it("does not fire below threshold", () => {
		const s = makeState([{ id: 1, text: "task", status: "pending" }], {
			userMessageCount: 8, lastTodoCallCount: 5,
		});
		expect(handleStallDetection(s)).toBe(false);
	});
});

// ── reminder ────────────────────────────────────────

describe("handleReminder", () => {
	it("fires when idle exceeds REMINDER_INTERVAL (2)", () => {
		const s = makeState([{ id: 1, text: "task", status: "pending" }], {
			userMessageCount: 5, lastTodoCallCount: 3,
		});
		expect(handleReminder(s)).toBe(true);
		expect(s.pendingSteerMessage).toContain("#1");
	});

	it("does not fire within interval", () => {
		const s = makeState([{ id: 1, text: "task", status: "pending" }], {
			userMessageCount: 4, lastTodoCallCount: 3,
		});
		expect(handleReminder(s)).toBe(false);
	});
});

// ── reminder / context builders ─────────────────────

describe("buildMinimalReminder", () => {
	it("mentions the next pending task", () => {
		const s = makeState([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "next", status: "pending" },
		]);
		expect(buildMinimalReminder(s)).toContain("#2 next");
	});

	it("returns empty string when no pending", () => {
		expect(buildMinimalReminder(makeState([{ id: 1, text: "done", status: "completed" }]))).toBe("");
	});
});

describe("buildBeforeAgentStartMessage", () => {
	it("injects hidden context for pending tasks only", () => {
		const s = makeState([
			{ id: 1, text: "a", status: "pending" },
			{ id: 2, text: "b", status: "completed" },
		]);
		const m = buildBeforeAgentStartMessage(s);
		expect(m).toBeDefined();
		expect(m!.message.display).toBe(false);
		expect(m!.message.customType).toBe("todo-context");
		expect(m!.message.content).toContain("#1: a");
		expect(m!.message.content).not.toContain("#2");
	});

	it("returns undefined when list empty", () => {
		expect(buildBeforeAgentStartMessage(makeState([]))).toBeUndefined();
	});

	it("returns undefined when all completed", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }]);
		expect(buildBeforeAgentStartMessage(s)).toBeUndefined();
	});
});

// ── reconstructState ────────────────────────────────

describe("reconstructState", () => {
	it("leaves state empty when no todo entry", () => {
		const entries = [{ type: "message", message: { role: "user", content: "hi" } }];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos).toEqual([]);
		expect(s.nextId).toBe(1);
	});

	it("replays the latest todo entry snapshot", () => {
		const entries = [todoEntry([{ id: 1, text: "a", status: "pending" }], 2)];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos).toHaveLength(1);
		expect(s.todos[0].text).toBe("a");
		expect(s.nextId).toBe(2);
	});

	it("uses the last todo entry and GCs older ones (splice from tail)", () => {
		const entries = [
			todoEntry([{ id: 1, text: "old", status: "pending" }], 2),
			todoEntry([{ id: 5, text: "new", status: "completed" }], 6),
		];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos[0].id).toBe(5);
		expect(s.nextId).toBe(6);
		expect(entries).toHaveLength(1);
	});

	it("migrates legacy status on replay", () => {
		const legacy = [{ id: 1, text: "a", status: "failed" }] as unknown as Todo[];
		const entries = [todoEntry(legacy, 2)];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos[0].status).toBe("pending");
	});
});

// ── agent_end integration (短路顺序) ────────────────

describe("agent_end short-circuit order", () => {
	it("completion steer fires before auto-clear (completion does not short-circuit)", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], { userMessageCount: 5 });
		// 模拟 agent_end: handleCompletionSteer(不短路) → handleAutoClear(短路)
		expect(handleCompletionSteer(s)).toBe(true);
		expect(s.pendingSteerMessage).toContain("交付质量");
		expect(handleAutoClear(s)).toEqual({ handled: true, cleared: false });
		expect(s.allCompletedAtCount).toBe(5);
	});

	it("after delay, auto-clear clears but the one-shot steer stays queued", () => {
		// 竞态点：completion steer 早已置位，auto-clear 现在清空 todos
		const s = makeState([{ id: 1, text: "a", status: "completed" }], {
			userMessageCount: 7, allCompletedAtCount: 5,
			completionSteered: true, pendingSteerMessage: "<queued>",
		});
		expect(handleCompletionSteer(s)).toBe(false); // 已 steered，不重复
		expect(handleAutoClear(s).cleared).toBe(true);
		expect(s.todos).toEqual([]);
		// pendingSteerMessage 仍保留，由下一 turn before_agent_start 消费（此时 todos 已空）
		expect(s.pendingSteerMessage).toBe("<queued>");
	});
});
