import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore } from "../../src/core/task/FileTaskStore.js";
import { TaskRunner } from "../../src/core/task/TaskRunner.js";
import type { TaskExecutor } from "../../src/core/task/TaskRunner.js";
import { AgentLoop } from "../../src/core/agent/AgentLoop.js";
import { Planner } from "../../src/core/planner/Planner.js";
import { ScriptedLLM, finalTurn } from "../unit/helpers.js";

/**
 * Phase 6 acceptance: a task survives a restart.
 *
 * The "restart" is real, not simulated by a flag: the first store is abandoned
 * and a *second* `FileTaskStore` is constructed on the same directory, exactly
 * as a new process would. Recovery then reads the records off disk.
 *
 * The executor is a real `AgentLoop` driven by a scripted provider. The provider
 * is a test double for the *network* boundary (the one place a double is
 * justified); the loop, planner, store and runner are the real implementations.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aurora-task-recovery-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A real AgentLoop over a scripted provider, as a TaskExecutor. */
function loopExecutor(answers: string[]): TaskExecutor {
  let index = 0;
  return {
    async execute(task) {
      const answer = answers[index++] ?? "no more answers";
      const loop = new AgentLoop({
        llm: new ScriptedLLM([finalTurn(`${answer}: ${task.prompt}`)]),
        planner: new Planner(),
        limits: { maxIterations: 5, maxToolCalls: 5, timeoutMs: 10_000 },
      });
      const result = await loop.run(task.prompt);
      return {
        status: result.status,
        output: result.output,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    },
  };
}

describe("task recovery across a restart", () => {
  it("requeues an interrupted task and runs it to completion after restart", async () => {
    // ── process 1: create and claim, then "crash" mid-run ──────────────────
    const first = new FileTaskStore(root);
    const task = await first.create({ prompt: "write the report", id: "job", maxAttempts: 3 });
    const claimed = await first.claimNext();
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);

    // On disk the task is stuck in `running` — the crash left it there.
    const stuck = JSON.parse(await readFile(join(root, "job.json"), "utf8"));
    expect(stuck.status).toBe("running");

    // ── process 2: a fresh store on the same directory ─────────────────────
    const second = new FileTaskStore(root);
    const report = await second.recover();
    expect(report.requeued).toEqual([task.id]);
    expect((await second.get("job"))?.status).toBe("queued");

    // It is runnable again, and running it completes.
    const runner = new TaskRunner({ store: second, executor: loopExecutor(["done"]) });
    const run = await runner.runNext();

    expect(run?.task.status).toBe("completed");
    expect(run?.task.attempts).toBe(2); // the interrupted attempt still counted
    expect(run?.task.output).toBe("done: write the report");
    expect(run?.task.history.map((h) => h.runStatus)).toEqual(["completed"]);
  });

  it("fails an interrupted task that had used its last attempt", async () => {
    const first = new FileTaskStore(root);
    await first.create({ prompt: "one shot", id: "fragile", maxAttempts: 1 });
    await first.claimNext(); // attempts = 1 == maxAttempts, then crash

    const second = new FileTaskStore(root);
    const report = await second.recover();

    expect(report.exhausted).toEqual(["fragile"]);
    expect(report.requeued).toEqual([]);
    const after = await second.get("fragile");
    expect(after?.status).toBe("failed");
    // It is not runnable, so the queue is not blocked by it.
    const runner = new TaskRunner({ store: second, executor: loopExecutor(["x"]) });
    expect(await runner.runNext()).toBeNull();
  });

  it("retries a resource-bound run across restarts until attempts run out", async () => {
    const store = new FileTaskStore(root);
    await store.create({ prompt: "bounded", id: "b", maxAttempts: 2 });

    // Attempt 1: the run hits the iteration bound → requeued, not failed.
    const timeoutExecutor: TaskExecutor = {
      async execute() {
        return { status: "max_iterations", output: "" };
      },
    };
    const runner = new TaskRunner({ store, executor: timeoutExecutor });
    const first = await runner.runNext();
    expect(first?.task.status).toBe("queued");
    expect(first?.task.attempts).toBe(1);

    // Attempt 2 exhausts the budget → failed.
    const second = await runner.runNext();
    expect(second?.task.status).toBe("failed");
    expect(second?.task.attempts).toBe(2);
  });

  it("keeps a completed task completed across a restart", async () => {
    const first = new FileTaskStore(root);
    await first.create({ prompt: "done", id: "d" });
    const runner = new TaskRunner({ store: first, executor: loopExecutor(["ok"]) });
    await runner.runNext();

    const second = new FileTaskStore(root);
    const report = await second.recover();
    expect(report.requeued).toEqual([]);
    expect((await second.get("d"))?.status).toBe("completed");
    expect(await second.claimNext()).toBeNull();
  });
});
