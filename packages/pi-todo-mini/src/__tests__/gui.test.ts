import { describe, expect, it } from "vitest";

import { buildGui, type Todo } from "../model";

describe("buildGui", () => {
	it("maps 4 statuses to list-tree with correct icons", () => {
		const todos: Todo[] = [
			{ id: 1, text: "pending task", status: "pending" },
			{ id: 2, text: "active task", status: "in_progress" },
			{ id: 3, text: "done task", status: "completed" },
			{ id: 4, text: "cancelled task", status: "cancelled" },
		];
		const gui = buildGui(todos);
		expect(gui.v).toBe(1);
		expect(gui.component.type).toBe("list-tree");
		const items = gui.component.props.items;
		expect(items).toHaveLength(4);
		// pending → dot, no status（guiResult 的 stripUndefined 删除 undefined 键）
		expect(items[0]).toMatchObject({ icon: "dot", label: "#1: pending task", depth: 0 });
		expect(items[0]).not.toHaveProperty("status");
		// in_progress → circle, running
		expect(items[1]).toMatchObject({ icon: "circle", label: "#2: active task", status: "running", depth: 0 });
		// completed → check, done
		expect(items[2]).toMatchObject({ icon: "check", label: "#3: done task", status: "done", depth: 0 });
		// cancelled → cross, failed
		expect(items[3]).toMatchObject({ icon: "cross", label: "#4: cancelled task", status: "failed", depth: 0 });
	});

	it("empty todos → empty list-tree", () => {
		const gui = buildGui([]);
		expect(gui.component.props.items).toEqual([]);
	});

	it("isVerification todo still maps correctly", () => {
		const todos: Todo[] = [{ id: 1, text: "verify", status: "pending", isVerification: true }];
		const gui = buildGui(todos);
		expect(gui.component.props.items[0]).toMatchObject({ icon: "dot", label: "#1: verify" });
	});
});
