// Behavioral tests for todo dual-form traps (text/texts, id/ids).
//
// Complements the source-text prompt-quality locks in tool-prompt.test.ts: those
// verify the Correct/error STRINGS exist; these exercise the actual throw logic of
// handleAdd/handleDelete, so a refactor cannot silently drop the dual-form detection.
//
// handleAdd/handleDelete were exported specifically to enable these tests.

import { describe, expect, it } from "vitest";

import { createTodoSessionState } from "../state";
import { handleAdd, handleDelete } from "../tool";

describe("handleAdd — text/texts dual-form detection", () => {
  it("triggers dual-form error when singular 'text' used instead of 'texts'", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add", text: "write spec" })).toThrow(
      /singular "text"|add needs texts/,
    );
  });

  it("throws 'requires texts' when neither text nor texts given", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add" })).toThrow(/requires texts/);
  });

  it("throws 'requires texts' on empty array (missing, not dual-form)", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add", texts: [] })).toThrow(/requires texts/);
  });

  it("does NOT throw when correct 'texts' array provided", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add", texts: ["write spec"] })).not.toThrow();
  });
});

describe("handleDelete — id/ids dual-form detection", () => {
  it("triggers dual-form error when singular 'id' used instead of 'ids'", () => {
    const state = createTodoSessionState();
    expect(() => handleDelete(state, { action: "delete", id: 5 })).toThrow(
      /singular "id"|delete needs ids/,
    );
  });

  it("throws 'requires ids' when neither id nor ids given", () => {
    const state = createTodoSessionState();
    expect(() => handleDelete(state, { action: "delete" })).toThrow(/requires ids/);
  });

  it("does NOT throw when correct 'ids' array provided (after seeding a todo)", () => {
    const state = createTodoSessionState();
    handleAdd(state, { action: "add", texts: ["temp"] }); // seed todo #1
    expect(() => handleDelete(state, { action: "delete", ids: [1] })).not.toThrow();
  });
});
