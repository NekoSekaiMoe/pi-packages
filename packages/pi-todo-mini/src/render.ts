/**
 * Todo 渲染函数 — 状态栏、widget（双列）、tool result 渲染。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	getDisplayStatus,
	type Todo,
	type TodoDetails,
} from "./model";

// ── 常量 ────────────────────────────────────────────

const MAX_COLLAPSED_ITEMS = 5;
export const FALLBACK_TERM_WIDTH = 80;

/**
 * Pi 对单个 extension widget 的最大字符串行数为 10（InteractiveMode.MAX_WIDGET_LINES）。
 * 扩展侧保守使用 max - 1 = 9 行作为阈值，超过时切换为双列布局，避免触发截断。
 */
const WIDGET_MAX_LINES = 9;
const SINGLE_COLUMN_BUDGET = WIDGET_MAX_LINES - 1;

/** 垂直分割线视觉宽度（" │ "） */
const DIVIDER_VISUAL_WIDTH = 3;
const ELLIPSIS_MIN_WIDTH = 3;

/** 截断或补齐到精确视觉宽度，截断时追加 "..." */
function fixedWidth(text: string, width: number): string {
	const len = visibleWidth(text);
	if (len <= width) {
		return text + " ".repeat(width - len);
	}
	if (width <= ELLIPSIS_MIN_WIDTH) return "...".slice(0, width);
	return truncateToWidth(text, width - ELLIPSIS_MIN_WIDTH) + "...";
}

// ── 状态栏 ────────────────────────────────────────────

export function renderStatusText(todoList: Todo[], th: Theme): string {
	if (todoList.length === 0) return "";

	const completed = todoList.filter((t) => getDisplayStatus(t) === "completed").length;
	const total = todoList.length;

	if (completed === total) {
		return th.fg("success", `\u2713 ${completed}/${total}`);
	}
	return th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`);
}

// ── Widget 双列渲染 ──────────────────────────────────

/** 渲染单条 todo 的 widget 行（不含缩进），供 component.ts 复用 */
function renderWidgetItem(t: Todo, th: Theme): string {
	const mark =
		t.status === "completed"
			? th.fg("success", "\u2713")
			: t.status === "in_progress"
				? th.fg("warning", "\u25cf")
				: t.status === "cancelled"
					? th.fg("error", "\u2715")
					: th.fg("dim", "\u25cb");
	const id = th.fg("accent", `#${t.id}`);
	const text =
		t.status === "completed" || t.status === "cancelled" ? th.fg("dim", t.text) : th.fg("text", t.text);
	return `${mark} ${id} ${text}`;
}

/** 单列布局渲染（widget 少量任务时使用） */
const PI_TEXT_PADDING = 2;

function renderSingleColumn(
	todos: Todo[],
	th: Theme,
	termWidth: number,
	indent: string,
): string[] {
	const maxWidth = Math.max(1, termWidth - PI_TEXT_PADDING);
	return todos.map((t) => truncateToWidth(indent + renderWidgetItem(t, th), maxWidth));
}

/** 双列布局渲染，供 widget 和 component 复用 */
const COLUMN_COUNT = 2;

export function renderDualColumn(
	todos: Todo[],
	th: Theme,
	termWidth: number,
	indent: string,
): string[] {
	const colWidth = Math.floor((termWidth - indent.length - DIVIDER_VISUAL_WIDTH) / COLUMN_COUNT);
	const lines: string[] = [];
	const half = Math.ceil(todos.length / COLUMN_COUNT);
	const divider = " " + th.fg("borderMuted", "\u2502") + " ";
	for (let row = 0; row < half; row++) {
		const left = fixedWidth(indent + renderWidgetItem(todos[row], th), colWidth);
		const rightIdx = row + half;
		const right = rightIdx < todos.length
			? fixedWidth(renderWidgetItem(todos[rightIdx], th), colWidth)
			: " ".repeat(colWidth);
		lines.push(left + divider + right);
	}
	return lines;
}

/** 渲染 widget 行（根据任务数自动选择单列或双列布局） */
export function renderWidgetLines(
	todoList: Todo[],
	th: Theme,
	termWidth?: number,
): string[] {
	if (todoList.length === 0) return [];

	const width = termWidth ?? (process.stdout.columns || FALLBACK_TERM_WIDTH);
	const lines: string[] = [];
	const completed = todoList.filter((t) => getDisplayStatus(t) === "completed").length;
	const total = todoList.length;

	lines.push(th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`));

	// 标题占 1 行；任务部分超过 WIDGET_MAX_LINES - 1 时启用双列
	const indent = "  ";
	if (todoList.length <= SINGLE_COLUMN_BUDGET) {
		for (const line of renderSingleColumn(todoList, th, width, indent)) {
			lines.push(line);
		}
	} else {
		for (const line of renderDualColumn(todoList, th, width, indent)) {
			lines.push(line);
		}
	}

	return lines;
}

// ── 列表渲染辅助函数 ─────────────────────────────────

function buildTodoListText(todoList: Todo[], options: { expanded: boolean }, theme: Theme): string {
	if (todoList.length === 0) {
		return theme.fg("dim", "No todos");
	}
	let listText = theme.fg("muted", `${todoList.length} todos:`);
	const display = options.expanded ? todoList : todoList.slice(0, MAX_COLLAPSED_ITEMS);
	for (const t of display) {
		const status = getDisplayStatus(t);
		const mark =
			status === "completed"
				? theme.fg("success", "\u2713")
				: status === "in_progress"
					? theme.fg("warning", "\u25cf")
					: status === "cancelled"
						? theme.fg("error", "\u2715")
						: theme.fg("dim", "\u25cb");
		const itemText =
			status === "completed" || status === "cancelled" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
		listText += `\n${mark} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
	}
	if (!options.expanded && todoList.length > MAX_COLLAPSED_ITEMS) {
		listText += `\n${theme.fg("dim", `... ${todoList.length - MAX_COLLAPSED_ITEMS} more`)}`;
	}
	return listText;
}

// ── Tool renderResult handler ────────────────────────

import { Text } from "@earendil-works/pi-tui";

export function renderTodoResult(result: unknown, options: { expanded: boolean }, theme: Theme): Text {
	const r = result as { content: Array<{ type: string; text?: string }>; details?: unknown };
	const details = r.details as TodoDetails | undefined;
	if (!details) {
		const text = r.content[0];
		return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
	}

	const todoList = details.todos;

	switch (details.action) {
		case "list": {
			return new Text(buildTodoListText(todoList, options, theme), 0, 0);
		}

		case "add":
		case "update":
		case "delete":
		case "clear": {
			const text = r.content[0];
			const msg = text?.type === "text" ? (text.text ?? "") : "";
			const listText = buildTodoListText(todoList, options, theme);
			return new Text(
				theme.fg("success", "\u2713 ") + theme.fg("muted", msg) + "\n\n" + listText,
				0,
				0,
			);
		}

		default: {
			const text = r.content[0];
			const msg = text?.type === "text" ? (text.text ?? "") : "";
			return new Text(theme.fg("dim", msg || "Done"), 0, 0);
		}
	}
}

