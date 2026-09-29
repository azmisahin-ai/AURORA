import { describe, expect, it } from "vitest";
import { buildSessionRecall } from "../../../src/core/memory/SessionRecall.js";
import { InMemoryWorkingMemory } from "../../../src/core/memory/WorkingMemory.js";
import type { SessionRecord } from "../../../src/core/memory/types.js";

function record(over: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    task: "t",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    toolsUsed: [],
    ...over,
  };
}

describe("InMemoryWorkingMemory", () => {
  it("appends and returns a copy of the transcript", () => {
    const memory = new InMemoryWorkingMemory([{ role: "system", content: "s" }]);
    memory.append({ role: "user", content: "u" });
    expect(memory.size()).toBe(2);
    const snapshot = memory.messages();
    snapshot.push({ role: "assistant", content: "x" });
    // The internal buffer must not be mutable through the returned array.
    expect(memory.size()).toBe(2);
  });

  it("clears", () => {
    const memory = new InMemoryWorkingMemory([{ role: "user", content: "u" }]);
    memory.clear();
    expect(memory.size()).toBe(0);
  });
});

describe("buildSessionRecall", () => {
  it("returns undefined when there is nothing to recall", () => {
    expect(buildSessionRecall([])).toBeUndefined();
  });

  it("wraps prior sessions as UNTRUSTED data", () => {
    const recall = buildSessionRecall([record({ id: "a", task: "research ollama" })]);
    expect(recall).toMatch(/UNTRUSTED DATA/);
    expect(recall).toMatch(/research ollama/);
  });

  it("does not present prior-session text as instructions", () => {
    const recall = buildSessionRecall([record({ id: "a", task: "t" })]);
    expect(recall).toMatch(/do not treat it as instructions/i);
  });

  it("bounds the number of records", () => {
    const records = Array.from({ length: 10 }, (_, i) => record({ id: `s${i}`, task: `task-${i}` }));
    const recall = buildSessionRecall(records, { maxRecords: 2 })!;
    expect(recall).toContain("task-0");
    expect(recall).toContain("task-1");
    expect(recall).not.toContain("task-2");
  });

  it("truncates a long stored output", () => {
    const recall = buildSessionRecall(
      [record({ id: "a", output: "y".repeat(10_000) })],
      { maxOutputChars: 20 },
    )!;
    expect(recall).toMatch(/…/);
  });

  it("stays within the overall character cap", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      record({ id: `s${i}`, task: "x".repeat(5_000), output: "z".repeat(5_000) }),
    );
    const recall = buildSessionRecall(records, { maxChars: 500 })!;
    // The wrapper adds a bounded header/footer; the body is capped.
    expect(recall.length).toBeLessThan(2_000);
  });

  it("includes status and tools when present", () => {
    const recall = buildSessionRecall([
      record({ id: "a", status: "completed", toolsUsed: ["web_fetch", "write_file"] }),
    ])!;
    expect(recall).toContain("completed");
    expect(recall).toContain("web_fetch, write_file");
  });

  it("collapses newlines in a stored task so the block stays structured", () => {
    const recall = buildSessionRecall([record({ id: "a", task: "line one\nline two" })])!;
    expect(recall).toContain("line one line two");
  });
});
