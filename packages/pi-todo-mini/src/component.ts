/**
 * /todos 命令的 TUI 组件 — 独立可关闭的 todo 列表视图（双列布局）。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { Todo } from "./model";
import { FALLBACK_TERM_WIDTH, renderDualColumn } from "./render";

const HEADER_PREFIX_DASHES = 3;
const HEADER_RESERVED_WIDTH = 10;

export class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const termWidth = width || FALLBACK_TERM_WIDTH;
		const indent = "  ";

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "\u2500".repeat(HEADER_PREFIX_DASHES)) + title + th.fg("borderMuted", "\u2500".repeat(Math.max(0, termWidth - HEADER_RESERVED_WIDTH)));
		lines.push(truncateToWidth(headerLine, termWidth));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`${indent}${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, termWidth));
		} else {
			const completed = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`${indent}${th.fg("muted", `${completed}/${total} completed`)}`, termWidth));
			lines.push("");

			for (const line of renderDualColumn(this.todos, th, termWidth, indent)) {
				lines.push(line);
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`${indent}${th.fg("dim", "Press Escape to close")}`, termWidth));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
