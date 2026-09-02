/**
 * Todo Extension — 轻量三态任务清单（pending / in_progress / completed）。
 *
 * 设计定位：刻意不做状态机约束（与 goal 扩展的 7 态对立），状态自由流转；
 * 状态持久化复用 Pi 自动记录的 toolResult entry（非 appendEntry）；
 * 通过 agent_end → before_agent_start 的延迟 steer 驱动任务推进。
 *
 * 文件职责：
 * - state.ts:    TodoSessionState 会话状态接口 + 工厂（闭包内创建，session 隔离）
 * - model.ts:    纯函数数据层（Todo 类型、migrateTodo 兼容迁移、addTodos/updateTodos、format/buildGui）
 * - tool.ts:     todo tool 注册 — 5 个 action（list/add/update/delete/clear）+ execute dispatcher
 * - handlers.ts: 5 个事件处理器（session_start/session_tree/agent_start/before_agent_start/agent_end）
 *                + reconstructState（回放最后一条 todo toolResult）+ steer 四机制（autoClear/completion/stall/reminder）
 * - render.ts:   状态栏（status line）/ widget（单双列自适应）/ tool result 三层渲染
 * - component.ts: /todos 命令的 TodoListComponent TUI 视图（只读双列）
 * - commands.ts: /todos 命令注册
 * - index.ts（本文件）: 工厂入口（创建 state + 注册 tool/command/event + refreshDisplay）
 *
 * 错误处理：handler 失败直接 throw（见 CLAUDE.md「Tool 设计」），不返回错误成功模式。
 * model 层纯函数返回 Result 对象（合法），dispatcher 拿到 error 时 throw。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerTodosCommand } from "./commands";
import { registerTodoEventHandlers } from "./handlers";
import { renderStatusText, renderWidgetLines } from "./render";
import { createTodoSessionState } from "./state";
import { registerTodoTool } from "./tool";

// ── 扩展入口 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── 闭包内状态（session 隔离） ─────────────────────
	const state = createTodoSessionState();

	// 全解耦：不再暴露 pi.__todoGetList 跨扩展 API（goal 不再读 todo 状态）。
	// todo 进度由 AI 自行管理，goal 不做强制检查。

	// ── 刷新显示（依赖闭包 state） ─────────────────────
	function refreshDisplay(ctx: ExtensionContext): void {
		const statusText = renderStatusText(state.todos, ctx.ui.theme);
		ctx.ui.setStatus("todo", statusText || undefined);
		if (state.todos.length === 0) {
			ctx.ui.setWidget("todo", undefined);
		} else {
			ctx.ui.setWidget("todo", renderWidgetLines(state.todos, ctx.ui.theme));
		}
	}

	// ── 注册所有 handler / tool / command ──────────────
	registerTodoEventHandlers(pi, state, refreshDisplay);
	registerTodoTool(pi, state, refreshDisplay);
	registerTodosCommand(pi, state);
}
