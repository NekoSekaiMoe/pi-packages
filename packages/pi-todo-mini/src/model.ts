/**
 * Todo 数据模型 — 纯函数，不依赖 Pi 运行时。
 * 四态: pending → in_progress → completed；任一状态 → cancelled
 * （cancelled 不可恢复；isVerification 标记验证任务，FR-6 completion audit 用）
 */


// ── 数据模型 ─────────────────────────────────────────

export interface Todo {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	/** 验证任务标记（FR-6 completion audit）。验证任务必须 completed，不可 cancelled。 */
	isVerification?: boolean;
}

export interface TodoDetails {
	action: "list" | "add" | "update" | "delete" | "clear";
	todos: Todo[];
	nextId: number;
	/** GUI 渲染结果（仅 RPC 模式填充，前端 list-tree 渲染）。对齐 extension-protocol@0.2.0。 */
	__gui__?: unknown;
}

export const VALID_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

export type ValidStatus = (typeof VALID_STATUSES)[number];

// ── 迁移/兼容 ───────────────────────────────────────

/** 旧格式迁移：verifying → in_progress，failed → pending，done:boolean → status */
export function migrateTodo(raw: Todo): Todo {
	const record = raw as unknown as Record<string, unknown>;
	const hasValidStatus =
		typeof record.status === "string" &&
		VALID_STATUSES.includes(record.status as ValidStatus);

	let status: ValidStatus;
	if (hasValidStatus) {
		status = record.status as ValidStatus;
	} else {
		// 极旧格式 done: boolean
		const { done } = record as { done?: boolean };
		status = done === true ? "completed" : "pending";
	}

	// 旧版五态映射（先转 string 避免类型收窄后无法比较）
	const rawStatus = record.status as string | undefined;
	if (rawStatus === "verifying") status = "in_progress";
	if (rawStatus === "failed") status = "pending";

	return {
		id: record.id as number,
		text: record.text as string,
		status,
		// FR-6: 保留 isVerification 标记（可选字段，旧数据可能缺失）
		isVerification: record.isVerification === true ? true : undefined,
	};
}

// ── GUI 渲染辅助（@xyz-agent/extension-protocol 最小内联，保持零依赖）──

export type TreeItemIcon = "arrow" | "check" | "cross" | "circle" | "dot" | "pause" | "branch";

export interface TreeItem {
	icon?: TreeItemIcon;
	label: string;
	status?: "running" | "done" | "failed";
	depth?: number;
	children?: TreeItem[];
}

export interface GuiComponent {
	type: string;
	props: Record<string, unknown>;
}

export interface GuiRenderResult {
	v: number;
	component: GuiComponent;
}

function stripUndefined(obj: unknown): unknown {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) return (obj as unknown[]).map(stripUndefined);
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		if (value !== undefined) result[key] = typeof value === "object" ? stripUndefined(value) : value;
	}
	return result;
}

function guiResult(component: GuiComponent): GuiRenderResult {
	return { v: 1, component: stripUndefined(component) as GuiComponent };
}

function guiComponent(type: string, props: Record<string, unknown>): GuiComponent {
	return { type, props };
}

/**
 * 把 todos 映射为 list-tree GuiRenderResult（RPC/GUI 模式用）：
 *   pending → dot/无 status，in_progress → circle/running，
 *   completed → check/done，cancelled → cross/failed
 */
export function buildGui(todos: Todo[]): GuiRenderResult {
	const items: TreeItem[] = todos.map((t) => ({
		icon: t.status === "completed" ? "check" : t.status === "in_progress" ? "circle" : t.status === "cancelled" ? "cross" : "dot",
		label: `#${t.id}: ${t.text}`,
		status: t.status === "in_progress" ? "running" : t.status === "completed" ? "done" : t.status === "cancelled" ? "failed" : undefined,
		depth: 0,
	}));
	return guiResult(guiComponent("list-tree", { items }));
}

export function getDisplayStatus(t: Todo): string {
	return migrateTodo(t).status;
}

// ── Add 逻辑 ─────────────────────────────────────────

export interface AddResult {
	newTodos: Todo[];
	newNextId: number;
	error?: string;
	resultText?: string;
}

export function addTodos(
	currentTodos: Todo[],
	currentNextId: number,
	texts: string[],
	isVerification?: boolean,
): AddResult {
	if (!texts || texts.length === 0) {
		return {
			newTodos: currentTodos,
			newNextId: currentNextId,
			error: "texts required",
			resultText: "Error: add requires texts parameter (non-empty array)",
		};
	}

	const trimmed = texts.map((t) => t.trim()).filter((t) => t.length > 0);
	if (trimmed.length === 0) {
		return {
			newTodos: currentTodos,
			newNextId: currentNextId,
			error: "all texts empty",
			resultText: "Error: texts must contain at least one non-empty string",
		};
	}

	const startId = currentNextId;
	const newTodos = [...currentTodos];
	let nextId = currentNextId;
	for (let i = 0; i < trimmed.length; i++) {
		newTodos.push({
			id: nextId++,
			text: trimmed[i],
			status: "pending" as const,
			// FR-6: isVerification 标记验证任务（可选，仅 add 时可设）
			isVerification: isVerification === true ? true : undefined,
		});
	}
	const endId = nextId - 1;

	return {
		newTodos,
		newNextId: nextId,
		resultText: `Added ${trimmed.length} todos (#${startId}-#${endId})`,
	};
}

// ── Update 逻辑 ──────────────────────────────────────

export interface UpdateResult {
	updatedTodos: Todo[];
	error?: string;
	resultText?: string;
}

export function updateTodos(
	currentTodos: Todo[],
	updates: Array<{ id: number; status?: string; text?: string }>,
): UpdateResult {
	const ids = updates.map((u) => u.id);
	if (new Set(ids).size !== ids.length) {
		return {
			updatedTodos: currentTodos,
			error: "duplicate ids in updates",
			resultText: "Error: duplicate ids in updates",
		};
	}
	for (const u of updates) {
		const todo = currentTodos.find((t) => t.id === u.id);
		if (!todo) {
			return {
				updatedTodos: currentTodos,
				error: `id ${u.id} not found`,
				resultText: `Error: Todo #${u.id} not found`,
			};
		}
		if (!u.status && !u.text) {
			return {
				updatedTodos: currentTodos,
				error: `update item for id ${u.id} has neither status nor text`,
				resultText: `Error: update item for id ${u.id} has neither status nor text`,
			};
		}
		if (u.status && !VALID_STATUSES.includes(u.status as (typeof VALID_STATUSES)[number])) {
			return {
				updatedTodos: currentTodos,
				error: `invalid status: ${u.status}`,
				resultText: `Error: invalid status '${u.status}' for update item id ${u.id}`,
			};
		}
		// FR-6 不变量守卫：(a) cancelled 不可恢复；(b) 验证任务不可 cancelled
		if (todo.status === "cancelled" && u.status !== undefined) {
			return {
				updatedTodos: currentTodos,
				error: `id ${u.id} is cancelled`,
				resultText: `Error: Todo #${u.id} is cancelled and cannot be restored`,
			};
		}
		if (todo.isVerification && u.status === "cancelled") {
			return {
				updatedTodos: currentTodos,
				error: `id ${u.id} is verification todo`,
				resultText: `Error: Todo #${u.id} is a verification todo and cannot be cancelled`,
			};
		}
	}

	const updated = currentTodos.map((t) => {
		const u = updates.find((u) => u.id === t.id);
		if (!u) return t;
		const patch: Partial<Todo> = {};
		if (u.status) patch.status = u.status as Todo["status"];
		if (u.text) patch.text = u.text;
		return { ...t, ...patch };
	});
	return {
		updatedTodos: updated,
		resultText: `Updated ${updates.length} todo(s)`,
	};
}

// ── 格式化辅助 ───────────────────────────────────────

export function formatTodoLine(t: Todo): string {
	const mark =
		t.status === "completed"
			? "x"
			: t.status === "in_progress"
				? "~"
				: t.status === "cancelled"
					? "-"
					: " ";
	return `[${mark}] #${t.id}: ${t.text}`;
}
