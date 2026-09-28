import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore } from "../../../src/core/task/FileTaskStore.js";
import { TaskRunner, nextTaskStatus } from "../../../src/core/task/TaskRunner.js";
import type { TaskExecutor, TaskRunOutcome } from "../../../src/core/task/TaskRunner.js";
import type { TaskRecord } from "../../../src/core/task/types.js";
import type { RunStatus } from "../../../src/core/agent/types.js";

let root: string;
let store: FileTaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aurora-runner-"));
  store = new FileTaskStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Executor that returns a scripted outcome per call, and records prompts. */
class ScriptedExecutor implements TaskExecutor {
  readonly seen: string[] = [];
  constructor(private readonly outcomes: TaskRunOutcome[]) {}
  async execute(task: TaskRecord): Promise<TaskRunOutcome> {
    this.seen.push(task.prompt);
    const next = this.outcomes.shift();
    if (!next) throw new Error("executor script exhausted");
    return next;
  }
}

function record(attempts: number, maxAttempts = 3): TaskRecord {
  return {
    id: "t",
    prompt: "x",
    status: "running",
    attempts,
    maxAttempts,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    history: [],
    tags: [],
  };
}

describe("nextTaskStatus mapping", () => {
  it("maps a completed run to a completed task", () => {
    expect(nextTaskStatus("completed", record(1))).toBe("completed");
  });

  it("maps an aborted run to waiting — paused, not failed", () => {
    expect(nextTaskStatus("aborted", record(1))).toBe("waiting");
  });

  it("maps max_verifications to waiting, not failed", () => {
    // Phase 4 flagged this as recoverable and needing escalation; `waiting`
    // says "resumable", which a blind retry would not.
    expect(nextTaskStatus("max_verifications", record(3, 3))).toBe("waiting");
  });

  it("retries resource-bound statuses while attempts remain", () => {
    for (const status of ["timeout", "max_iterations", "max_tool_calls"] as RunStatus[]) {
      expect(nextTaskStatus(status, record(1, 3)), status).toBe("queued");
    }
  });

  it("fails resource-bound statuses once attempts are exhausted", () => {
    for (const status of ["timeout", "max_iterations", "max_tool_calls"] as RunStatus[]) {
      expect(nextTaskStatus(status, record(3, 3)), status).toBe("failed");
    }
  });

  it("fails an error run regardless of remaining attempts", () => {
    // An `error` is a real failure; retrying it blindly would just repeat it.
    expect(nextTaskStatus("error", record(1, 3))).toBe("failed");
  });
});

describe("TaskRunner.runNext", () => {
  it("runs a claimed task and records the attempt in history", async () => {
    await store.create({ prompt: "hello", id: "a" });
    const runner = new TaskRunner({
      store,
      executor: new ScriptedExecutor([{ status: "completed", output: "done" }]),
    });

    const report = await runner.runNext();
    expect(report?.task.status).toBe("completed");
    expect(report?.task.output).toBe("done");
    expect(report?.task.history).toHaveLength(1);
    expect(report?.task.history[0]).toMatchObject({
      attempt: 1,
      runStatus: "completed",
      ok: true,
    });
  });

  it("requeues a retryable run and keeps the attempt in history", async () => {
    await store.create({ prompt: "x", id: "a", maxAttempts: 2 });
    const runner = new TaskRunner({
      store,
      executor: new ScriptedExecutor([{ status: "timeout", output: "" }]),
    });

    const report = await runner.runNext();
    expect(report?.task.status).toBe("queued");
    expect(report?.task.history).toHaveLength(1);
    expect(report?.task.history[0]!.runStatus).toBe("timeout");
  });

  it("fails a retryable run when attempts are exhausted", async () => {
    await store.create({ prompt: "x", id: "a", maxAttempts: 1 });
    const runner = new TaskRunner({
      store,
      executor: new ScriptedExecutor([{ status: "max_iterations", output: "" }]),
    });

    const report = await runner.runNext();
    expect(report?.task.status).toBe("failed");
  });

  it("turns a thrown executor error into a failed task, not a crash", async () => {
    await store.create({ prompt: "x", id: "a" });
    const runner = new TaskRunner({
      store,
      executor: {
        async execute() {
          throw new Error("provider exploded");
        },
      },
    });

    const report = await runner.runNext();
    expect(report?.task.status).toBe("failed");
    expect(report?.outcome.status).toBe("error");
    expect(report?.task.error).toBe("provider exploded");
  });

  it("returns null when nothing is queued", async () => {
    const runner = new TaskRunner({ store, executor: new ScriptedExecutor([]) });
    expect(await runner.runNext()).toBeNull();
  });
});

describe("TaskRunner.drain", () => {
  it("runs queued tasks in order, bounded by maxTasks", async () => {
    await store.create({ prompt: "one", id: "1" });
    await store.create({ prompt: "two", id: "2" });
    await store.create({ prompt: "three", id: "3" });
    const executor = new ScriptedExecutor([
      { status: "completed", output: "1" },
      { status: "completed", output: "2" },
    ]);
    const runner = new TaskRunner({ store, executor });

    const reports = await runner.drain(2);
    expect(reports.map((r) => r.task.id)).toEqual(["1", "2"]);
    expect(executor.seen).toEqual(["one", "two"]);
    // The third is untouched.
    expect((await store.get("3"))?.status).toBe("queued");
  });

  it("stops when the queue empties", async () => {
    await store.create({ prompt: "only", id: "1" });
    const runner = new TaskRunner({
      store,
      executor: new ScriptedExecutor([{ status: "completed", output: "" }]),
    });
    const reports = await runner.drain(10);
    expect(reports).toHaveLength(1);
  });

  it("stops early when the signal is aborted", async () => {
    await store.create({ prompt: "one", id: "1" });
    await store.create({ prompt: "two", id: "2" });
    const controller = new AbortController();
    controller.abort();
    const runner = new TaskRunner({ store, executor: new ScriptedExecutor([]) });
    const reports = await runner.drain(10, controller.signal);
    expect(reports).toEqual([]);
  });
});
