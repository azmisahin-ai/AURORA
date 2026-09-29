import type { RunResult } from "../core/agent/types.js";

/**
 * Ports the HTTP layer depends on (Phase 9, ADR 011).
 *
 * The API knows how to *route* and how to *authorize*; it must not know how to
 * build a provider or an agent. `AgentRuntime` satisfies `RuntimePort`
 * structurally, so the composition root passes the real runtime in and the
 * server's tests pass a scripted fake — which is why the API tests need no
 * model (ADR 011 §2).
 */
export interface RuntimePort {
  /** Run one task to completion. `signal` aborts the run. */
  runTask(
    task: string,
    opts?: { signal?: AbortSignal; runId?: string; taskId?: string },
  ): Promise<RunResult>;
  /** Provider reachability, for `/health`. Never a credential check. */
  health(): Promise<boolean>;
}

/** The lifecycle of one asynchronous run, as seen over HTTP. */
export type ApiRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface ApiRunRecord {
  id: string;
  task: string;
  status: ApiRunStatus;
  startedAt: string;
  finishedAt?: string;
  /** Present once the run finishes; the loop's own result, unmodified. */
  result?: RunResult;
  /** Present on `failed`; already redacted before it leaves the server. */
  error?: string;
}

export interface ApiServerOptions {
  host: string;
  port: number;
  /**
   * Bearer token required on every route except `/health`. Empty means no auth
   * — which is only legal on a loopback bind (`assertSafeBinding`).
   */
  token: string;
  maxBodyBytes: number;
  rateLimit: number;
  rateRefill: number;
  maxConcurrentRuns: number;
  maxSyncMs: number;
}
