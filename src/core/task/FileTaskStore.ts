import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  canTransition,
  isTerminal,
  TaskNotFoundError,
  TaskTransitionError,
  type CreateTaskInput,
  type RecoveryReport,
  type TaskAttempt,
  type TaskFilter,
  type TaskRecord,
  type TaskStatus,
  type TaskStore,
} from "./types.js";

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Filesystem-backed task store: one JSON record per task at `<root>/<id>.json`.
 *
 * Three properties are load-bearing and each has a test:
 *
 *  1. **Atomic writes.** Every write goes to a temp file and is `rename`d into
 *     place. `rename` within a directory is atomic on POSIX, so a crash can
 *     leave an old record or a new one — never a half-written one. A store
 *     that could truncate a record on crash would defeat the point of Phase 6.
 *  2. **Checked transitions.** State changes go through the table in
 *     `types.ts`; an illegal move throws instead of silently corrupting the
 *     lifecycle.
 *  3. **Bounded recovery.** `recover()` requeues interrupted work only while
 *     attempts remain. An interrupted task that had already used its last
 *     attempt is failed, not requeued forever (ADR 001/006).
 *
 * Scope: this is a *single-process* store. Mutations are serialised in-process
 * so concurrent callers cannot interleave a read-modify-write, but there is no
 * cross-process lock — two processes on the same directory are not supported,
 * and pretending otherwise with an advisory lock would be a false guarantee.
 */
export class FileTaskStore implements TaskStore {
  private readonly root: string;
  /** Serialises read-modify-write sequences within this process. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
  }

  get rootDir(): string {
    return this.root;
  }

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("Task prompt must not be empty");

    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: normalizeTaskId(input.id ?? `task-${randomUUID()}`),
      prompt,
      status: "queued",
      attempts: 0,
      maxAttempts: normalizeMaxAttempts(input.maxAttempts),
      createdAt: now,
      updatedAt: now,
      history: [],
      tags: input.tags ?? [],
    };

    return this.withLock(async () => {
      await this.ensureRoot();
      const path = this.pathFor(record.id);
      // Refuse to clobber: create is not an upsert.
      const existing = await this.readRaw(record.id);
      if (existing !== null) {
        throw new Error(`Task "${record.id}" already exists`);
      }
      await this.writeAtomic(path, record);
      return record;
    });
  }

  async get(id: string): Promise<TaskRecord | null> {
    return this.readRaw(normalizeTaskId(id));
  }

  async list(filter?: TaskFilter): Promise<TaskRecord[]> {
    const records: TaskRecord[] = [];
    for (const id of await this.idsOnDisk()) {
      // `list` is a display path: a single unreadable file must not blank the
      // whole listing. `recover()` is the integrity path that reports them.
      const record = await this.readRaw(id).catch(() => null);
      if (record === null) continue;
      if (filter?.status !== undefined && record.status !== filter.status) continue;
      if (filter?.tag !== undefined && !record.tags.includes(filter.tag)) continue;
      records.push(record);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return filter?.limit !== undefined ? records.slice(0, filter.limit) : records;
  }

  async update(
    id: string,
    status: TaskStatus,
    patch?: Partial<
      Pick<
        TaskRecord,
        "output" | "error" | "finishedAt" | "startedAt" | "history" | "attempts"
      >
    >,
  ): Promise<TaskRecord> {
    const safeId = normalizeTaskId(id);
    return this.withLock(async () => {
      const record = await this.readRaw(safeId);
      if (record === null) throw new TaskNotFoundError(safeId);
      if (!canTransition(record.status, status)) {
        throw new TaskTransitionError(safeId, record.status, status);
      }
      const next: TaskRecord = {
        ...record,
        ...patch,
        status,
        updatedAt: new Date().toISOString(),
      };
      if (isTerminal(status) && next.finishedAt === undefined) {
        next.finishedAt = next.updatedAt;
      }
      await this.writeAtomic(this.pathFor(safeId), next);
      return next;
    });
  }

  async claimNext(): Promise<TaskRecord | null> {
    return this.withLock(async () => {
      const queued = (await this.list({ status: "queued" }));
      for (const candidate of queued) {
        if (candidate.attempts >= candidate.maxAttempts) {
          // A queued task with no attempts left can never run. Fail it and move
          // on, rather than letting it block the queue forever.
          await this.transitionInLock(candidate, "failed", {
            error:
              `Task exhausted its ${candidate.maxAttempts} attempt(s) while queued.`,
          });
          continue;
        }
        const now = new Date().toISOString();
        return this.transitionInLock(candidate, "running", {
          attempts: candidate.attempts + 1,
          startedAt: now,
        });
      }
      return null;
    });
  }

  async requeue(
    id: string,
    patch?: Partial<Pick<TaskRecord, "error" | "output" | "history">>,
  ): Promise<TaskRecord> {
    const safeId = normalizeTaskId(id);
    return this.withLock(async () => {
      const record = await this.readRaw(safeId);
      if (record === null) throw new TaskNotFoundError(safeId);
      if (record.status !== "running" && record.status !== "waiting") {
        throw new TaskTransitionError(safeId, record.status, "queued");
      }
      // `running → queued` is not in the general transition graph; requeue is
      // the one named operation allowed to perform it, so it is written
      // directly rather than through `update`.
      const next: TaskRecord = {
        ...record,
        ...patch,
        status: "queued",
        updatedAt: new Date().toISOString(),
      };
      await this.writeAtomic(this.pathFor(safeId), next);
      return next;
    });
  }

  async recover(): Promise<RecoveryReport> {
    return this.withLock(async () => {
      const report: RecoveryReport = { requeued: [], exhausted: [], corrupt: [] };
      for (const id of await this.idsOnDisk()) {
        let record: TaskRecord | null;
        try {
          record = await this.readRaw(id);
        } catch {
          report.corrupt.push(id);
          continue;
        }
        if (record === null || record.status !== "running") continue;

        if (record.attempts >= record.maxAttempts) {
          await this.transitionInLock(record, "failed", {
            error:
              `Interrupted after ${record.attempts}/${record.maxAttempts} attempt(s); ` +
              `no attempts remain, so it is not requeued.`,
          });
          report.exhausted.push(record.id);
        } else {
          const next: TaskRecord = {
            ...record,
            status: "queued",
            error: "Recovered from an interrupted run; requeued for another attempt.",
            updatedAt: new Date().toISOString(),
          };
          await this.writeAtomic(this.pathFor(record.id), next);
          report.requeued.push(record.id);
        }
      }
      return report;
    });
  }

  /** Transition helper used inside an already-held lock. */
  private async transitionInLock(
    record: TaskRecord,
    status: TaskStatus,
    patch: Partial<TaskRecord>,
  ): Promise<TaskRecord> {
    if (!canTransition(record.status, status)) {
      throw new TaskTransitionError(record.id, record.status, status);
    }
    const next: TaskRecord = {
      ...record,
      ...patch,
      status,
      updatedAt: new Date().toISOString(),
    };
    if (isTerminal(status) && next.finishedAt === undefined) {
      next.finishedAt = next.updatedAt;
    }
    await this.writeAtomic(this.pathFor(record.id), next);
    return next;
  }

  private pathFor(id: string): string {
    return join(this.root, `${id}.json`);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  private async idsOnDisk(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => n.slice(0, -".json".length));
  }

  /** Read and validate a record. Returns null when absent; throws when corrupt. */
  private async readRaw(id: string): Promise<TaskRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Task record "${id}" is not valid JSON`);
    }
    return validateRecord(id, parsed);
  }

  /**
   * Write via temp file + rename. `rename` is atomic within a filesystem, so a
   * reader sees either the old record or the new one, never a partial write.
   */
  private async writeAtomic(path: string, record: TaskRecord): Promise<void> {
    await this.ensureRoot();
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Serialise a read-modify-write sequence against other in-process callers. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Keep the chain alive even if this operation rejects.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Filesystem-safe, non-empty. Mirrors the knowledge-store slug guard. */
export function normalizeTaskId(raw: string): string {
  const id = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 128);
  if (id.length === 0) throw new Error(`Invalid task id: ${JSON.stringify(raw)}`);
  if (id === "." || id === "..") throw new Error(`Invalid task id: ${JSON.stringify(raw)}`);
  return id;
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Defend against hand-edited or truncated records: fill defaults and reject a
 * record whose status is not one we understand (that is corruption, and the
 * caller must hear about it rather than get a task stuck in a phantom state).
 */
function validateRecord(id: string, parsed: unknown): TaskRecord {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Task record "${id}" is not an object`);
  }
  const r = parsed as Partial<TaskRecord>;
  const status = r.status;
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "waiting" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    throw new Error(`Task record "${id}" has unknown status ${JSON.stringify(status)}`);
  }
  const now = new Date(0).toISOString();
  return {
    id,
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    status,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    maxAttempts:
      typeof r.maxAttempts === "number" && r.maxAttempts >= 1
        ? r.maxAttempts
        : DEFAULT_MAX_ATTEMPTS,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
    history: Array.isArray(r.history) ? (r.history as TaskAttempt[]) : [],
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    ...(typeof r.output === "string" ? { output: r.output } : {}),
    ...(typeof r.error === "string" ? { error: r.error } : {}),
    ...(typeof r.startedAt === "string" ? { startedAt: r.startedAt } : {}),
    ...(typeof r.finishedAt === "string" ? { finishedAt: r.finishedAt } : {}),
  };
}
