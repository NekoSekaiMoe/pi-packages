/**
 * Todo 会话状态 — 在工厂闭包内创建，被 tool / handlers / commands 共享。
 * 所有方法原地修改 state 对象（共享引用），无需返回新对象。
 *
 * 拆分理由：原 928 行的 src/index.ts 把状态、操作、事件、命令、渲染混在一起。
 * 抽出 state 接口后，tool.ts / handlers.ts / commands.ts 都可以接受
 * 同一个 TodoSessionState 引用，避免工厂闭包耦合。
 */

import type { Todo } from "./model";

export interface TodoSessionState {
	todos: Todo[];
	nextId: number;
	// 用户消息轮数与提醒追踪
	userMessageCount: number;
	lastTodoCallCount: number;
	stallNotified: boolean;
	allCompletedAtCount: number | null;
	/** 全部 completed 时已注入 steer，防止重复 */
	completionSteered: boolean;
	/** agent_end 设置、before_agent_start 消费的延迟 steer 消息 */
	pendingSteerMessage: string | null;
}

export function createTodoSessionState(): TodoSessionState {
	return {
		todos: [],
		nextId: 1,
		userMessageCount: 0,
		lastTodoCallCount: 0,
		stallNotified: false,
		allCompletedAtCount: null,
		completionSteered: false,
		pendingSteerMessage: null,
	};
}
