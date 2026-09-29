import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SessionRecord, SessionStore, SessionWriteInput } from "./types.js";

export interface SessionMemoryOptions {
  /** Root directory for session JSON files. */
  dir: string;
  /** Maximum stored length of a session's final output. */
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 4_000;

/**
 * Filesystem-backed Session memory (ADR 009).
 *
 * Reuses the Phase 6 durability lesson verbatim: every write goes to a temp
 * file and is `rename`d into place, so a crash cannot leave a half-written
 * session that a later `recent()` would choke on. The store is deliberately
 * small — a session record is an auditable extract, not a transcript.
 *
 * Single-process scope, like `FileTaskStore`: no cross-process lock.
 */
export class FileSessionStore implements SessionStore {
  private readonly dir: string;
  private readonly maxOutputChars: number;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: SessionMemoryOptions) {
    this.dir = opts.dir;
    this.maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  /** Builds a record from a run, without persisting it. */
  static toRecord(input: SessionWriteInput, opts: { now?: string; id?: string } = {}): SessionRecord {
    const now = opts.now ?? new Date().toISOString();
    return {
      id: input.id ?? opts.id ?? `session-${randomUUID()}`,
      task: input.task,
      createdAt: now,
      updatedAt: now,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.output !== undefined ? { output: input.output } : {}),
      toolsUsed: input.toolsUsed ?? [],
      ...(input.iterations !== undefined ? { iterations: input.iterations } : {}),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.resumedFrom !== undefined && input.resumedFrom.length > 0
        ? { resumedFrom: input.resumedFrom }
        : {}),
    };
  }

  async save(record: SessionRecord): Promise<void> {
    // Preserve `createdAt` when overwriting an existing record.
    const existing = await this.get(record.id);
    const stamped: SessionRecord = {
      ...record,
      ...(existing ? { createdAt: existing.createdAt } : {}),
      updatedAt: new Date().toISOString(),
      output:
        record.output !== undefined ? record.output.slice(0, this.maxOutputChars) : undefined,
    };
    if (stamped.output === undefined) delete (stamped as { output?: string }).output;
    await this.serialise(() => this.writeAtomic(this.pathFor(record.id), stamped));
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    try {
      const raw = await readFile(this.pathFor(safeId(id)), "utf8");
      return JSON.parse(raw) as SessionRecord;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async list(): Promise<SessionRecord[]> {
    const records = await this.readAll();
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async recent(limit: number, exclude: readonly string[] = []): Promise<SessionRecord[]> {
    const skip = new Set(exclude);
    const all = await this.list();
    return all.filter((record) => !skip.has(record.id)).slice(0, Math.max(0, limit));
  }

  private async readAll(): Promise<SessionRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const records: SessionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as SessionRecord);
      } catch {
        // A record we cannot read is skipped, not fatal: one bad file must not
        // make the whole session history unreadable.
      }
    }
    return records;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${safeId(id)}.json`);
  }

  /** Serialises writes in-process so two saves cannot interleave. */
  private serialise<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(op);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async writeAtomic(path: string, record: SessionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}

/** Keeps ids safe for use as filenames: no separators, no traversal. */
function safeId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "" || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
  }
  return trimmed;
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}
