import type { RunStatus } from "../agent/types.js";
import type { TaskAttempt, TaskRecord, TaskStatus, TaskStore } from "./types.js";

/**
 * What the runner needs from whatever actually performs the work. The
 * composition root supplies an adapter over `AgentRuntime`, so `core/task` never
 * imports providers (ADR 001). The interface is the seam that lets the runner be
 * tested against a real `AgentLoop` with a scripted provider, with no network.
 */
export interface TaskExecutor {
  execute(task: TaskRecord, signal?: AbortSignal): Promise<TaskRunOutcome>;
}

/** The subset of an agent run the runner needs. */
export interface TaskRunOutcome {
  status: RunStatus;
  output: string;
  error?: string;
}

export interface TaskRunnerOptions {
  store: TaskStore;
  executor: TaskExecutor;
  logger?: import("pino").Logger;
}

export interface TaskRunReport {
  task: TaskRecord;
  outcome: TaskRunOutcome;
}

/**
 * Drives persisted tasks through an executor.
 *
 * The runner is where persistence meets the agent loop, so it owns exactly one
 * decision: **what a run outcome means for the task's lifecycle.** That mapping
 * is a small, explicit table rather than a guess:
 *
 * | run status          | task status | why                                    |
 * |---------------------|-------------|----------------------------------------|
 * | `completed`         | `completed` | the external check agreed (ADR 006)     |
 * | `aborted`           | `waiting`   | paused by the caller; resumable         |
 * | `max_verifications` | `waiting`   | needs intervention, not a rewrite       |
 * | `timeout`           | retry       | ran out of room, not wrong              |
 * | `max_iterations`    | retry       | ditto                                   |
 * | `max_tool_calls`    | retry       | ditto                                   |
 * | `error`             | `failed`    | the work itself did not succeed         |
 *
 * "retry" means `queued` when attempts remain, `failed` when they do not. The
 * distinction matters: a run that hit a resource bound did not produce a wrong
 * answer, so retrying it is legitimate, whereas an `error` is a real failure and
 * retrying it blindly would just repeat it.
 *
 * `max_verifications` is deliberately `waiting`, not `failed`: Phase 4 flagged it
 * as a recoverable outcome that needs escalation, and `waiting` is the state
 * that says "a human or a later decision can resume this".
 */
export class TaskRunner {
  private readonly store: TaskStore;
  private readonly executor: TaskExecutor;
  private readonly logger?: import("pino").Logger;

  constructor(opts: TaskRunnerOptions) {
    this.store = opts.store;
    this.executor = opts.executor;
    if (opts.logger !== undefined) this.logger = opts.logger;
  }

  /** Run every currently-queued task, oldest first. Bounded by `maxTasks`. */
  async drain(maxTasks = Number.POSITIVE_INFINITY, signal?: AbortSignal): Promise<TaskRunReport[]> {
    const reports: TaskRunReport[] = [];
    while (reports.length < maxTasks) {
      if (signal?.aborted) break;
      const report = await this.runNext(signal);
      if (report === null) break;
      reports.push(report);
    }
    return reports;
  }

  /** Claim and run one task. Returns null when nothing is runnable. */
  async runNext(signal?: AbortSignal): Promise<TaskRunReport | null> {
    const task = await this.store.claimNext();
    if (task === null) return null;

    this.logger?.info(
      { taskId: task.id, attempt: task.attempts, maxAttempts: task.maxAttempts },
      "task claimed",
    );

    let outcome: TaskRunOutcome;
    try {
      outcome = await this.executor.execute(task, signal);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      outcome = { status: "error", output: "", error: message };
    }

    const startedAt = task.startedAt ?? task.updatedAt;
    const finishedAt = new Date().toISOString();
    const ok = outcome.status === "completed";
    const attempt: TaskAttempt = {
      attempt: task.attempts,
      startedAt,
      finishedAt,
      runStatus: outcome.status,
      ok,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };

    const nextStatus = nextTaskStatus(outcome.status, task);
    const patch = {
      output: outcome.output,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      history: [...task.history, attempt],
    };
    // A retry goes through `requeue` (the only legal `running → queued` path);
    // everything else is a plain transition.
    const updated =
      nextStatus === "queued"
        ? await this.store.requeue(task.id, patch)
        : await this.store.update(task.id, nextStatus, patch);

    this.logger?.info(
      { taskId: task.id, runStatus: outcome.status, taskStatus: nextStatus },
      "task finished",
    );

    return { task: updated, outcome };
  }
}

/**
 * Resource-bound run statuses. Hitting one means the work did not get to finish,
 * which is retryable; it is not evidence the work is wrong.
 */
const RETRYABLE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "timeout",
  "max_iterations",
  "max_tool_calls",
]);

/** Outcome → next lifecycle state. Exported so the mapping itself is testable. */
export function nextTaskStatus(runStatus: RunStatus, task: TaskRecord): TaskStatus {
  if (runStatus === "completed") return "completed";
  if (runStatus === "aborted") return "waiting";
  if (runStatus === "max_verifications") return "waiting";
  if (RETRYABLE_RUN_STATUSES.has(runStatus)) {
    return task.attempts < task.maxAttempts ? "queued" : "failed";
  }
  return "failed";
}
