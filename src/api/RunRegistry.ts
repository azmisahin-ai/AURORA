import { randomUUID } from "node:crypto";
import type { RunResult } from "../core/agent/types.js";
import type { ApiRunRecord, ApiRunStatus, RuntimePort } from "./types.js";

export interface RunRegistryOptions {
  runtime: RuntimePort;
  /** Runs allowed to execute at once; beyond this, `start` rejects. */
  maxConcurrentRuns: number;
  /**
   * Completed records retained for `GET /runs/:id`. Oldest are dropped first.
   * A bound on *history*, not on concurrency: an agent server that keeps every
   * finished run forever is a memory leak with a nice API.
   */
  maxRetained?: number;
  logger?: import("pino").Logger;
  /** Scrubs an infrastructure error string before it is exposed over HTTP. */
  scrub?: (text: string) => string;
}

export class RunCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`At most ${limit} concurrent run(s) are allowed`);
    this.name = "RunCapacityError";
  }
}

/**
 * In-memory registry of asynchronous agent runs (Phase 9, ADR 011).
 *
 * Runs are deliberately **not** persisted. A run in flight is a live process
 * doing live work; after a restart it is unrecoverable, and claiming otherwise
 * would be a false guarantee. Durable work is Phase 6's job (`aurora tasks`),
 * which persists records and bounds retries; the API is the interactive
 * surface. This is stated, not implied.
 */
export class RunRegistry {
  private readonly runtime: RuntimePort;
  private readonly maxConcurrentRuns: number;
  private readonly maxRetained: number;
  private readonly logger?: import("pino").Logger;
  private readonly scrub: (text: string) => string;
  private readonly runs = new Map<string, ApiRunRecord>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(opts: RunRegistryOptions) {
    this.runtime = opts.runtime;
    this.maxConcurrentRuns = opts.maxConcurrentRuns;
    this.maxRetained = opts.maxRetained ?? 200;
    this.scrub = opts.scrub ?? ((text) => text);
    if (opts.logger !== undefined) this.logger = opts.logger;
  }

  /** Number of runs currently executing. */
  activeCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.status === "running") n++;
    return n;
  }

  /**
   * Start a run in the background and return its record immediately. Rejects
   * with `RunCapacityError` when the concurrency bound is reached — the caller
   * maps that to `429`, not to an unbounded queue.
   */
  start(task: string): ApiRunRecord {
    if (this.activeCount() >= this.maxConcurrentRuns) {
      throw new RunCapacityError(this.maxConcurrentRuns);
    }
    const id = `run-${randomUUID()}`;
    const record: ApiRunRecord = {
      id,
      task,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.runs.set(id, record);
    const controller = new AbortController();
    this.controllers.set(id, controller);

    void this.execute(id, task, controller.signal);
    return record;
  }

  get(id: string): ApiRunRecord | undefined {
    return this.runs.get(id);
  }

  /**
   * All known runs, newest first. The UI's agent panel needs the set, not one
   * id at a time. In-memory by design (see the class comment), so this is the
   * full live history, already bounded by `maxRetained`.
   */
  list(): ApiRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Abort a running run. Returns the (possibly already-finished) record, or
   * undefined when the id is unknown. Aborting a finished run is a no-op that
   * reports the terminal state, not an error.
   */
  cancel(id: string): ApiRunRecord | undefined {
    const record = this.runs.get(id);
    if (record === undefined) return undefined;
    if (record.status === "running") this.controllers.get(id)?.abort();
    return record;
  }

  /** Stop every in-flight run; used on server shutdown. */
  cancelAll(): void {
    for (const [id, controller] of this.controllers) {
      const record = this.runs.get(id);
      if (record?.status === "running") controller.abort();
    }
  }

  private async execute(id: string, task: string, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.runtime.runTask(task, { signal });
      // A run that ends in `error` carries the provider's own message. That text
      // is surfaced over HTTP, so it gets the same scrub as a thrown one — log
      // redaction does not reach a response body.
      if (result.status === "error" && result.error !== undefined) {
        result.error = this.scrub(result.error);
      }
      this.finish(id, apiStatus(result), { result });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A cancellation surfaces as an abort from the loop, but may also throw;
      // report it as cancelled rather than failed when the signal is set.
      const status: ApiRunStatus = signal.aborted ? "cancelled" : "failed";
      this.finish(id, status, status === "failed" ? { error: this.scrub(message) } : {});
      this.logger?.warn({ runId: id, err: message }, "api run failed");
    }
  }

  private finish(
    id: string,
    status: Exclude<ApiRunStatus, "running">,
    extra: { result?: RunResult; error?: string },
  ): void {
    const record = this.runs.get(id);
    if (record === undefined) return;
    record.status = status;
    record.finishedAt = new Date().toISOString();
    if (extra.result !== undefined) record.result = extra.result;
    if (extra.error !== undefined) record.error = extra.error;
    this.controllers.delete(id);
    this.prune();
  }

  /** Drop oldest finished records once the retention bound is exceeded. */
  private prune(): void {
    if (this.runs.size <= this.maxRetained) return;
    const finished = [...this.runs.values()]
      .filter((r) => r.status !== "running")
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    let excess = this.runs.size - this.maxRetained;
    for (const record of finished) {
      if (excess <= 0) break;
      this.runs.delete(record.id);
      excess--;
    }
  }
}

/** Map the loop's run status onto the API's coarser lifecycle. */
export function apiStatus(result: RunResult): Exclude<ApiRunStatus, "running"> {
  if (result.status === "completed") return "completed";
  if (result.status === "aborted") return "cancelled";
  return "failed";
}
