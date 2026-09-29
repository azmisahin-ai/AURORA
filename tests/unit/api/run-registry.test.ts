import { describe, it, expect } from "vitest";
import { RunCapacityError, RunRegistry, apiStatus } from "../../../src/api/RunRegistry.js";
import type { RunResult } from "../../../src/core/agent/types.js";
import type { RuntimePort } from "../../../src/api/types.js";

/**
 * A scripted runtime *port*, not a mock of an internal function: `RuntimePort`
 * is the real interface the server depends on, and this double stands in for the
 * network boundary behind it (the LLM). That is why the API suite needs no
 * Ollama (ADR 011 §2).
 */
class FakeRuntime implements RuntimePort {
  readonly tasks: string[] = [];
  constructor(
    private readonly behaviour:
      | { kind: "ok"; output: string }
      | { kind: "throw"; message: string }
      | { kind: "hang" },
  ) {}

  async runTask(task: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
    this.tasks.push(task);
    if (this.behaviour.kind === "throw") throw new Error(this.behaviour.message);
    if (this.behaviour.kind === "hang") {
      return new Promise<RunResult>((_, reject) => {
        const abort = () => reject(new Error("aborted"));
        if (opts?.signal?.aborted) abort();
        else opts?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return {
      status: "completed",
      output: this.behaviour.output,
      iterations: 1,
      toolCalls: 0,
      trajectory: [],
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}

function completed(output: string): RunResult {
  return { status: "completed", output, iterations: 1, toolCalls: 0, trajectory: [] };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("RunRegistry", () => {
  it("runs a task and records the result", async () => {
    const registry = new RunRegistry({
      runtime: new FakeRuntime({ kind: "ok", output: "merhaba" }),
      maxConcurrentRuns: 2,
    });
    const record = registry.start("selam");
    expect(record.status).toBe("running");
    await tick();
    const finished = registry.get(record.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.result?.output).toBe("merhaba");
    expect(finished?.finishedAt).toBeDefined();
  });

  it("rejects a run beyond the concurrency bound instead of queueing", () => {
    const registry = new RunRegistry({
      runtime: new FakeRuntime({ kind: "hang" }),
      maxConcurrentRuns: 1,
    });
    registry.start("first");
    expect(() => registry.start("second")).toThrow(RunCapacityError);
    expect(registry.activeCount()).toBe(1);
  });

  it("marks a thrown error as failed and scrubs the message", async () => {
    const registry = new RunRegistry({
      runtime: new FakeRuntime({ kind: "throw", message: "boom" }),
      maxConcurrentRuns: 1,
      scrub: (text) => text.replace("boom", "[REDACTED]"),
    });
    const record = registry.start("task");
    await tick();
    const finished = registry.get(record.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toBe("[REDACTED]");
  });

  it("scrubs a provider error carried inside an error-status result", async () => {
    // The loop can return status "error" rather than throwing; that message is
    // surfaced over HTTP too, so it must be scrubbed on the same path.
    const runtime: RuntimePort = {
      runTask: async () => ({
        status: "error",
        output: "",
        iterations: 1,
        toolCalls: 0,
        trajectory: [],
        error: "auth failed for key sk-abcdef0123456789abcdef0123456789",
      }),
      health: async () => true,
    };
    const registry = new RunRegistry({
      runtime,
      maxConcurrentRuns: 1,
      scrub: (text) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]"),
    });
    const record = registry.start("task");
    await tick();
    const finished = registry.get(record.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.result?.error).not.toContain("sk-abcdef");
    expect(finished?.result?.error).toContain("[REDACTED]");
  });

  it("cancels a running run and reports it as cancelled", async () => {
    const registry = new RunRegistry({
      runtime: new FakeRuntime({ kind: "hang" }),
      maxConcurrentRuns: 1,
    });
    const record = registry.start("long task");
    const cancelled = registry.cancel(record.id);
    expect(cancelled?.status).toBe("running"); // still running at cancel time
    await tick();
    expect(registry.get(record.id)?.status).toBe("cancelled");
  });

  it("treats cancelling an unknown run as undefined, not an error", () => {
    const registry = new RunRegistry({
      runtime: new FakeRuntime({ kind: "ok", output: "x" }),
      maxConcurrentRuns: 1,
    });
    expect(registry.cancel("nope")).toBeUndefined();
  });

  it("prunes finished history beyond the retention bound", async () => {
    const registry = new RunRegistry({
      runtime: new FakeRuntime({ kind: "ok", output: "x" }),
      maxConcurrentRuns: 5,
      maxRetained: 2,
    });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(registry.start(`task-${i}`).id);
      await tick();
    }
    // The newest survive; the oldest finished records are dropped.
    expect(registry.get(ids[0]!)).toBeUndefined();
    expect(registry.get(ids[3]!)).toBeDefined();
  });
});

describe("apiStatus mapping", () => {
  it("maps the loop's run status onto the API lifecycle", () => {
    expect(apiStatus(completed("x"))).toBe("completed");
    expect(apiStatus({ ...completed(""), status: "aborted" })).toBe("cancelled");
    expect(apiStatus({ ...completed(""), status: "error" })).toBe("failed");
    expect(apiStatus({ ...completed(""), status: "max_iterations" })).toBe("failed");
  });
});
