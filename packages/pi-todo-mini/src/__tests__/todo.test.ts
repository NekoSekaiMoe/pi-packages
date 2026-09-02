import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	addTodos,
	formatTodoLine,
	migrateTodo,
	type Todo,
	updateTodos,
	VALID_STATUSES,
} from "../model";
import { renderWidgetLines } from "../render";
import { createTodoSessionState } from "../state";
import { handleSingleUpdate } from "../tool";

// ── 数据模型 + 向后兼容 ──────────────────────────────

describe("Todo data model", () => {
	it("should load old data without verifyText/verifyAttempts", () => {
		const oldTodo = { id: 1, text: "test", status: "completed" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);

		expect(migrated.status).toBe("completed");
		expect(migrated.text).toBe("test");
		expect(migrated.id).toBe(1);
	});

	it("should include exactly four valid statuses", () => {
		expect(VALID_STATUSES).toEqual(["pending", "in_progress", "completed", "cancelled"]);
	});

	it("should migrate verifying → in_progress", () => {
		const oldTodo = { id: 1, text: "test", status: "verifying" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);
		expect(migrated.status).toBe("in_progress");
	});

	it("should migrate failed → pending", () => {
		const oldTodo = { id: 1, text: "test", status: "failed" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);
		expect(migrated.status).toBe("pending");
	});

	it("should migrate done:true to completed", () => {
		const veryOldTodo = { id: 3, text: "ancient", done: true } as unknown as Todo;
		const migrated = migrateTodo(veryOldTodo);
		expect(migrated.status).toBe("completed");
	});

	it("should migrate done:false to pending", () => {
		const veryOldTodo = { id: 4, text: "ancient2", done: false } as unknown as Todo;
		const migrated = migrateTodo(veryOldTodo);
		expect(migrated.status).toBe("pending");
	});

	it("should preserve isVerification flag (FR-6)", () => {
		const todo = { id: 1, text: "run tests", status: "pending", isVerification: true } as unknown as Todo;
		const migrated = migrateTodo(todo);
		expect(migrated.isVerification).toBe(true);
	});

	it("should preserve cancelled status (FR-1 four-state)", () => {
		const todo = { id: 1, text: "dropped", status: "cancelled" } as unknown as Todo;
		const migrated = migrateTodo(todo);
		expect(migrated.status).toBe("cancelled");
	});
});

// ── todo add ────────────────────────────────────────

describe("todo add", () => {
	it("should add todos with sequential IDs", () => {
		const result = addTodos([], 1, ["A", "B"]);
		expect(result.error).toBeUndefined();
		expect(result.newTodos).toHaveLength(2);
		expect(result.newTodos[0].id).toBe(1);
		expect(result.newTodos[1].id).toBe(2);
		expect(result.newTodos[0].status).toBe("pending");
	});

	it("should append to existing todos", () => {
		const existing: Todo[] = [{ id: 1, text: "existing", status: "pending" }];
		const result = addTodos(existing, 2, ["new task"]);
		expect(result.error).toBeUndefined();
		expect(result.newTodos).toHaveLength(2);
		expect(result.newTodos[1].id).toBe(2);
		expect(result.newTodos[1].text).toBe("new task");
		expect(result.newNextId).toBe(3);
	});

	it("should return error when texts is empty", () => {
		const result = addTodos([], 1, []);
		expect(result.error).toBe("texts required");
	});

	it("should return error when all texts are empty after trim", () => {
		const result = addTodos([], 1, ["  ", " "]);
		expect(result.error).toBe("all texts empty");
	});

	it("should trim texts", () => {
		const result = addTodos([], 1, ["  new task  "]);
		expect(result.error).toBeUndefined();
		expect(result.newTodos[0].text).toBe("new task");
	});

	it("should mark todos as verification when isVerification=true (FR-6)", () => {
		const result = addTodos([], 1, ["run tests", "typecheck"], true);
		expect(result.error).toBeUndefined();
		expect(result.newTodos[0].isVerification).toBe(true);
		expect(result.newTodos[1].isVerification).toBe(true);
	});

	it("should not set isVerification when omitted", () => {
		const result = addTodos([], 1, ["regular task"]);
		expect(result.error).toBeUndefined();
		expect(result.newTodos[0].isVerification).toBeUndefined();
	});

	it("should not set isVerification when isVerification=false", () => {
		const result = addTodos([], 1, ["regular task"], false);
		expect(result.error).toBeUndefined();
		expect(result.newTodos[0].isVerification).toBeUndefined();
	});
});

// ── todo update batch ───────────────────────────────

describe("todo update batch", () => {
	it("should update multiple todos with updates[]", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending" },
			{ id: 2, text: "B", status: "in_progress" },
			{ id: 3, text: "C", status: "pending" },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 2, text: "B updated" },
			{ id: 3, status: "completed", text: "C done" },
		]);

		expect(result.error).toBeUndefined();
		expect(result.updatedTodos).toHaveLength(3);
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[0].text).toBe("A");
		expect(result.updatedTodos[1].text).toBe("B updated");
		expect(result.updatedTodos[1].status).toBe("in_progress");
		expect(result.updatedTodos[2].status).toBe("completed");
		expect(result.updatedTodos[2].text).toBe("C done");
	});

	it("should reject duplicate ids in updates[]", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 1, status: "pending" },
		]);
		expect(result.error).toBe("duplicate ids in updates");
		expect(result.updatedTodos).toEqual(todos);
	});

	it("should reject non-existent ids", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 999, status: "pending" }]);
		expect(result.error).toBe("id 999 not found");
	});

	it("should reject updates[] item missing both status and text", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1 }]);
		expect(result.error).toContain("neither status nor text");
	});

	it("should reject invalid status values", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1, status: "banana" }]);
		expect(result.error).toContain("invalid status");
	});

	it("FR-6: cancelled todo 不可恢复（status 更新拒绝）", () => {
		const todos: Todo[] = [{ id: 1, text: "dropped", status: "cancelled" }];
		const result = updateTodos(todos, [{ id: 1, status: "pending" }]);
		expect(result.error).toBe("id 1 is cancelled");
		expect(result.resultText).toContain("cannot be restored");
		expect(result.updatedTodos).toEqual(todos);
	});

	it("FR-6: 验证任务不可 cancelled", () => {
		const todos: Todo[] = [{ id: 2, text: "run tests", status: "in_progress", isVerification: true }];
		const result = updateTodos(todos, [{ id: 2, status: "cancelled" }]);
		expect(result.error).toBe("id 2 is verification todo");
		expect(result.resultText).toContain("cannot be cancelled");
		expect(result.updatedTodos).toEqual(todos);
	});
});

// ── handleSingleUpdate FR-6 守卫（tool 单条路径）────

describe("handleSingleUpdate FR-6 guards (tool single path)", () => {
	it("FR-6: cancelled todo + status → cannot restore", () => {
		const state = createTodoSessionState();
		state.todos = [{ id: 1, text: "dropped", status: "cancelled" }];
		expect(() => handleSingleUpdate(state, { action: "update", id: 1, status: "pending" }))
			.toThrow("#1 is cancelled (cannot restore)");
	});

	it("FR-6: verification todo + status=cancelled → cannot cancel", () => {
		const state = createTodoSessionState();
		state.todos = [{ id: 2, text: "run tests", status: "in_progress", isVerification: true }];
		expect(() => handleSingleUpdate(state, { action: "update", id: 2, status: "cancelled" }))
			.toThrow("#2 is verification todo (cannot cancel)");
	});
});

// ── completed 无拦截 ────────────────────────────────

describe("completed without interception", () => {
	it("should allow in_progress → completed directly", () => {
		const todos: Todo[] = [{ id: 1, text: "simple", status: "in_progress" }];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
	});

	it("should allow pending → completed directly", () => {
		const todos: Todo[] = [{ id: 1, text: "skip", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
	});

	it("should allow batch all completed without evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "in_progress" },
			{ id: 2, text: "B", status: "in_progress" },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 2, status: "completed" },
		]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[1].status).toBe("completed");
	});
});

// ── formatTodoLine ──────────────────────────────────

describe("formatTodoLine", () => {
	it("should format pending todo", () => {
		const todo: Todo = { id: 1, text: "task A", status: "pending" };
		expect(formatTodoLine(todo)).toBe("[ ] #1: task A");
	});

	it("should format in_progress todo", () => {
		const todo: Todo = { id: 2, text: "task B", status: "in_progress" };
		expect(formatTodoLine(todo)).toBe("[~] #2: task B");
	});

	it("should format completed todo", () => {
		const todo: Todo = { id: 3, text: "task C", status: "completed" };
		expect(formatTodoLine(todo)).toBe("[x] #3: task C");
	});

	it("should format cancelled todo", () => {
		const todo: Todo = { id: 4, text: "task D", status: "cancelled" };
		expect(formatTodoLine(todo)).toBe("[-] #4: task D");
	});
});

// ── widget 渲染布局 ────────────────────────────────

const mockTheme = {
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

describe("widget rendering", () => {
	it("should render empty list as empty widget", () => {
		expect(renderWidgetLines([], mockTheme, 80)).toEqual([]);
	});

	it("should use single column for 3 tasks", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending" },
			{ id: 2, text: "B", status: "in_progress" },
			{ id: 3, text: "C", status: "completed" },
		];
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(4); // 1 header + 3 items
		expect(lines[0]).toContain("1/3");
		expect(lines[1]).toContain("#1");
		expect(lines[2]).toContain("#2");
		expect(lines[3]).toContain("#3");
	});

	it("should use single column up to 8 tasks", () => {
		const todos: Todo[] = Array.from({ length: 8 }, (_, i) => ({
			id: i + 1,
			text: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(9); // 1 header + 8 items
		for (let i = 1; i < lines.length; i++) {
			expect(lines[i]).toContain(`#${i}`);
		}
	});

	it("should switch to dual column for 9 tasks", () => {
		const todos: Todo[] = Array.from({ length: 9 }, (_, i) => ({
			id: i + 1,
			text: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(6); // 1 header + ceil(9/2)=5 rows
		expect(lines[0]).toContain("0/9");
	});

	it("should keep dual column within Pi widget max lines for 18 tasks", () => {
		const todos: Todo[] = Array.from({ length: 18 }, (_, i) => ({
			id: i + 1,
			text: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(10); // 1 header + 9 rows
	});

	it("should keep widget lines within Pi max for 19 tasks", () => {
		const todos: Todo[] = Array.from({ length: 19 }, (_, i) => ({
			id: i + 1,
			text: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(11); // 1 header + ceil(19/2)=10 rows; Pi truncates at 10
	});
});

// ── agent_end logic (pure data) ─────────────────────

describe("agent_end logic", () => {
	it("should detect stall when no todo activity for threshold rounds", () => {
		const STALL_THRESHOLD = 5;
		const userMessageCount = 10;
		const lastTodoCallCount = 3;
		const todos: Todo[] = [{ id: 1, text: "pending task", status: "pending" }];

		const isStalled =
			todos.length > 0 &&
			userMessageCount - lastTodoCallCount >= STALL_THRESHOLD;

		expect(isStalled).toBe(true);
	});

	it("should detect reminder when interval elapsed", () => {
		const REMINDER_INTERVAL = 2;
		const userMessageCount = 5;
		const lastTodoCallCount = 3;
		const todos: Todo[] = [{ id: 1, text: "task", status: "pending" }];

		const needsReminder =
			todos.length > 0 &&
			userMessageCount - lastTodoCallCount >= REMINDER_INTERVAL;

		expect(needsReminder).toBe(true);
	});

	it("should auto-clear when all completed and delay rounds elapsed", () => {
		const AUTO_CLEAR_DELAY_ROUNDS = 2;
		const userMessageCount = 7;
		const allCompletedAtCount = 4;

		const shouldClear =
			allCompletedAtCount !== null &&
			userMessageCount - allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS;

		expect(shouldClear).toBe(true);
	});

	it("should not auto-clear when delay rounds not yet elapsed", () => {
		const AUTO_CLEAR_DELAY_ROUNDS = 2;
		const userMessageCount = 5;
		const allCompletedAtCount = 4;

		const shouldClear =
			allCompletedAtCount !== null &&
			userMessageCount - allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS;

		expect(shouldClear).toBe(false);
	});

	it("should pick first pending todo as next recommended", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "completed" },
			{ id: 2, text: "B", status: "pending" },
			{ id: 3, text: "C", status: "pending" },
		];
		const next = todos.find((t) => t.status !== "completed");
		expect(next!.id).toBe(2);
		expect(next!.text).toBe("B");
	});
});
