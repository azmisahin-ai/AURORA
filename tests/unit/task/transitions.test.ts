import { describe, it, expect } from "vitest";
import {
  canTransition,
  isTerminal,
  TASK_TRANSITIONS,
  TERMINAL_STATUSES,
  type TaskStatus,
} from "../../../src/core/task/types.js";

const ALL: readonly TaskStatus[] = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
];

describe("task transition table", () => {
  it("classifies exactly completed, failed and cancelled as terminal", () => {
    const terminal = ALL.filter(isTerminal);
    expect(terminal).toEqual(["completed", "failed", "cancelled"]);
    expect(TERMINAL_STATUSES).toEqual(["completed", "failed", "cancelled"]);
  });

  it("gives terminal states no outgoing transitions", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(TASK_TRANSITIONS[status], status).toEqual([]);
    }
  });

  it("rejects every self-transition", () => {
    for (const status of ALL) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  it("does not allow running → queued as a plain transition", () => {
    // Requeue is a named operation, not a generic update; the table must not
    // offer it, or a caller could silently reset a task mid-run.
    expect(canTransition("running", "queued")).toBe(false);
  });

  it("allows the documented lifecycle moves", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("running", "waiting")).toBe(true);
    expect(canTransition("waiting", "queued")).toBe(true);
    expect(canTransition("waiting", "running")).toBe(true);
    // A task can fail before it runs: an exhausted record is failed, not left
    // to block the queue.
    expect(canTransition("queued", "failed")).toBe(true);
  });

  it("does not revive a failed task by a plain transition", () => {
    expect(canTransition("failed", "queued")).toBe(false);
  });

  it("does not resurrect a completed or cancelled task", () => {
    for (const from of ["completed", "cancelled"] as const) {
      for (const to of ALL) {
        expect(canTransition(from, to), `${from}→${to}`).toBe(false);
      }
    }
  });
});
