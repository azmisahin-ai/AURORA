/**
 * Task persistence types (ADR 008).
 *
 * A task is a durable record of one unit of agent work. The store's job is
 * narrow and deliberate: keep the record *on disk* and make its state machine
 * impossible to violate. It does not run the work — that is `TaskRunner`.
 *
 * Two rules drive the shape below:
 *  1. Transitions are explicit and checked. A terminal task stays terminal.
 *  2. Recovery after a crash is *bounded* (ADR 001/006): a task that was
 *     interrupted on its last allowed attempt is failed, not requeued forever.
 */

/**
 * Lifecycle states.
 *
 * - `queued`    — ready to be claimed by a worker.
 * - `running`   — claimed; exactly one worker may hold it.
 * - `waiting`   — paused on an external condition (e.g. a cancelled run the
 *                 caller may resume). Resumable, unlike a failure.
 * - `completed` — finished successfully. Terminal.
 * - `failed`    — exhausted its attempts or hit a fatal error. Terminal.
 * - `cancelled` — abandoned deliberately. Terminal.
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

/**
 * The legal transition graph. Anything not listed here throws — including a
 * self-transition (re-claiming a `running` task must go through an explicit
 * recovery, not a silent re-mark).
 *
 * Terminal states have no outgoing edges here, so "terminal" means exactly
 * "cannot move by a plain transition". Reviving one is possible, but only
 * through a named operation (`requeue`), never by `update` — the same rule that
 * keeps `running → queued` out of the table.
 *
 * `queued → failed` exists because a task can fail *before* it runs: an
 * exhausted record is failed rather than left to block the queue.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "waiting"],
  waiting: ["queued", "running", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** Result of one attempt at a task, recorded on the task itself. */
export interface TaskAttempt {
  /** 1-based attempt number. */
  attempt: number;
  startedAt: string;
  finishedAt: string;
  /** Mirrors the agent run's terminal status, for provenance. */
  runStatus: string;
  ok: boolean;
  error?: string;
}

export interface TaskRecord {
  id: string;
  /** The task text handed to the agent. */
  prompt: string;
  status: TaskStatus;
  /**
   * How many attempts have *started*. Incremented when a worker claims the
   * task, so a crash mid-run still counts against the budget.
   */
  attempts: number;
  /** Hard cap on attempts; reaching it turns a failed task terminal. */
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  /** Last observed agent output, for inspection after a crash. */
  output?: string;
  /** Why the task is in its current state. */
  error?: string;
  /** Set when the task was last claimed. */
  startedAt?: string;
  /** Set when the task reached a terminal state. */
  finishedAt?: string;
  /** History of completed attempts, newest last. */
  history: TaskAttempt[];
  /** Free-form labels, e.g. a research topic. */
  tags: string[];
}

export interface CreateTaskInput {
  prompt: string;
  maxAttempts?: number;
  tags?: string[];
  /** Explicit id, for tests and idempotent creation. */
  id?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  tag?: string;
  limit?: number;
}

/**
 * What recovery found on disk. Corrupt files are *reported*, never silently
 * dropped: a record we cannot read is exactly the thing an operator needs to
 * know about.
 */
export interface RecoveryReport {
  /** Interrupted tasks moved back to `queued` for another attempt. */
  requeued: string[];
  /** Interrupted tasks that had no attempts left; moved to `failed`. */
  exhausted: string[];
  /** Records that could not be parsed; left untouched on disk. */
  corrupt: string[];
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | null>;
  list(filter?: TaskFilter): Promise<TaskRecord[]>;
  /**
   * Move a task to a new status, enforcing `TASK_TRANSITIONS`. Returns the
   * updated record. Throws `TaskTransitionError` on an illegal move and
   * `TaskNotFoundError` when the id is unknown.
   */
  update(
    id: string,
    status: TaskStatus,
    patch?: Partial<
      Pick<
        TaskRecord,
        "output" | "error" | "finishedAt" | "startedAt" | "history" | "attempts"
      >
    >,
  ): Promise<TaskRecord>;
  /**
   * Claim the oldest `queued` task: mark it `running`, bump `attempts`, record
   * `startedAt`. Skips (and fails) queued tasks with no attempts left, so one
   * poisoned record cannot block the queue. Returns null when none is runnable.
   */
  claimNext(): Promise<TaskRecord | null>;
  /**
   * Return a task to the queue for another attempt. This is the *only* legal
   * path from `running` back to `queued` — a plain `update` cannot do it, so a
   * requeue is always an explicit, named act (recovery after a crash, or a run
   * that hit a resource bound). Legal from `running` and `waiting` only; a
   * failed task is not revivable in place (create a new one), which keeps
   * "terminal" meaning the same thing everywhere.
   */
  requeue(
    id: string,
    patch?: Partial<Pick<TaskRecord, "error" | "output" | "history">>,
  ): Promise<TaskRecord>;
  /**
   * Bring a store back to a runnable state after a crash: every `running` task
   * is requeued if it has attempts left, failed if not. Corrupt files are
   * reported, not deleted.
   */
  recover(): Promise<RecoveryReport>;
}

export class TaskTransitionError extends Error {
  constructor(
    readonly id: string,
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Illegal task transition for "${id}": ${from} → ${to}`);
    this.name = "TaskTransitionError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`No task with id "${id}"`);
    this.name = "TaskNotFoundError";
  }
}
