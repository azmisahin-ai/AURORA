import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AllowAllGate, DenyAllGate, type ConfirmationGate } from "../security/ConfirmationGate.js";
import { KeyedRateLimiter } from "../security/RateLimiter.js";
import type { SecretRedactor } from "../security/SecretRedactor.js";
import type { FileKnowledgeStore } from "../core/knowledge/FileKnowledgeStore.js";
import type { FileTaskStore } from "../core/task/FileTaskStore.js";
import type { ApiServerOptions, RuntimePort } from "./types.js";
import { RunCapacityError, RunRegistry } from "./RunRegistry.js";

/** Dependencies the server is given; nothing here is constructed from the network. */
export interface ApiDeps {
  runtime: RuntimePort;
  tasks: FileTaskStore;
  knowledge: FileKnowledgeStore;
  logger?: import("pino").Logger;
  /**
   * Applied to error strings that leave over HTTP. Log redaction (Phase 8) does
   * not cover a response body, so a provider error quoting an API key must be
   * scrubbed here too.
   */
  redactor?: SecretRedactor;
}

export interface ApiServer {
  server: Server;
  registry: RunRegistry;
  /** Resolves once listening; `port` is the actual bound port (0 = ephemeral). */
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

/**
 * The confirmation gate an API run gets (ADR 011 §3, ADR 010).
 *
 * There is no stdin behind an HTTP request, so there is no one to answer a
 * prompt. The default is therefore **deny**: a mutating tool is refused unless
 * the operator explicitly opted in. This is why the API is read/research-shaped
 * by default and why the same `ConfirmationGate` seam from Phase 8 is reused
 * rather than a second, parallel policy.
 */
export function apiConfirmationGate(allowMutation: boolean): ConfirmationGate {
  return allowMutation ? new AllowAllGate() : new DenyAllGate();
}

/** A non-loopback bind without a token is refused: fail loudly, do not serve. */
export function assertSafeBinding(host: string, token: string): void {
  if (token.trim() !== "") return;
  if (isLoopbackHost(host)) return;
  throw new Error(
    `Refusing to bind ${host} without AURORA_API_TOKEN: this API can run an ` +
      `agent that executes commands. Set a token, or bind 127.0.0.1.`,
  );
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/** Constant-time token comparison: hash both so lengths cannot leak. */
export function tokenMatches(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

export function createApiServer(options: ApiServerOptions, deps: ApiDeps): ApiServer {
  assertSafeBinding(options.host, options.token);

  const registry = new RunRegistry({
    runtime: deps.runtime,
    maxConcurrentRuns: options.maxConcurrentRuns,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps.redactor !== undefined
      ? { scrub: (text: string) => deps.redactor!.redactString(text) }
      : {}),
  });
  const limiter =
    options.rateLimit > 0
      ? new KeyedRateLimiter({ capacity: options.rateLimit, refillPerSecond: options.rateRefill })
      : undefined;

  const server = createServer((req, res) => {
    void handle(req, res).catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.logger?.error({ err: message }, "api request failed");
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Health is the only unauthenticated route: an operator must be able to
    // probe liveness without a secret, and it exposes no credential state.
    if (path === "/health") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      const healthy = await deps.runtime.health().catch(() => false);
      return sendJson(res, healthy ? 200 : 503, { status: healthy ? "ok" : "degraded" });
    }

    if (options.token !== "") {
      const provided = bearer(req.headers.authorization);
      if (provided === undefined || !tokenMatches(options.token, provided)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return sendJson(res, 401, { error: "unauthorized" });
      }
    }

    if (limiter) {
      const decision = limiter.tryAcquire(remoteKey(req));
      if (!decision.allowed) {
        res.setHeader("Retry-After", Math.ceil(decision.retryAfterMs / 1000));
        return sendJson(res, 429, { error: "rate_limited" });
      }
    }

    const runMatch = /^\/runs\/([^/]+)$/.exec(path);
    const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);

    if (path === "/knowledge/search" || path === "/knowledge") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      return handleKnowledgeSearch(url, res);
    }
    if (path === "/agent/run") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
      return handleAgentRun(req, res, url);
    }
    if (path === "/agent/cancel") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
      return handleAgentCancel(req, res, url);
    }
    if (runMatch) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      const record = registry.get(decodeURIComponent(runMatch[1]!));
      if (record === undefined) return sendJson(res, 404, { error: "run_not_found" });
      return sendJson(res, 200, record);
    }
    if (taskMatch) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      const task = await deps.tasks.get(decodeURIComponent(taskMatch[1]!));
      if (task === null) return sendJson(res, 404, { error: "task_not_found" });
      return sendJson(res, 200, task);
    }
    return sendJson(res, 404, { error: "not_found" });
  }

  async function handleKnowledgeSearch(url: URL, res: ServerResponse): Promise<void> {
    const text = (url.searchParams.get("q") ?? url.searchParams.get("text") ?? "").trim();
    if (text === "") return sendJson(res, 400, { error: "missing_query" });
    const kind = url.searchParams.get("kind") ?? undefined;
    if (kind !== undefined && !["topic", "source", "research"].includes(kind)) {
      return sendJson(res, 400, { error: "invalid_kind" });
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return sendJson(res, 400, { error: "invalid_limit" });
    }
    const hits = await deps.knowledge.search({
      text,
      ...(kind !== undefined ? { kind: kind as "topic" | "source" | "research" } : {}),
      ...(url.searchParams.get("topic") ? { topic: url.searchParams.get("topic")! } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return sendJson(res, 200, {
      results: hits.map((h) => ({
        kind: h.entry.metadata.kind,
        slug: h.entry.metadata.slug,
        title: h.entry.metadata.title,
        source: h.entry.metadata.source ?? null,
        verified: h.entry.metadata.verified,
        score: h.score,
        matchedTerms: h.matchedTerms,
      })),
    });
  }

  async function handleAgentRun(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const parsed = await readBody(req, options.maxBodyBytes);
    if (!parsed.ok) return rejectBadBody(req, res, parsed.cause);
    const body = parsed.value;

    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (task === "") return sendJson(res, 400, { error: "missing_task" });

    const waitParam = url.searchParams.get("wait");
    const wantsWait = body.wait === true || waitParam === "1" || waitParam === "true";
    let record;
    try {
      record = registry.start(task);
    } catch (cause) {
      if (cause instanceof RunCapacityError) {
        return sendJson(res, 429, { error: "run_capacity", limit: cause.limit });
      }
      throw cause;
    }

    if (!wantsWait) return sendJson(res, 202, record);

    const finished = await waitFor(record.id, options.maxSyncMs);
    // If it did not finish within the bound, it is still running: answer 202
    // rather than hold the socket. The caller polls `GET /runs/:id`.
    if (finished === undefined || finished.status === "running") {
      return sendJson(res, 202, registry.get(record.id) ?? record);
    }
    return sendJson(res, finished.status === "completed" ? 200 : 500, finished);
  }

  async function waitFor(id: string, ms: number): Promise<ReturnType<RunRegistry["get"]>> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const record = registry.get(id);
      if (record !== undefined && record.status !== "running") return record;
      await new Promise((r) => setTimeout(r, 25));
    }
    return registry.get(id);
  }

  async function handleAgentCancel(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const parsed = await readBody(req, options.maxBodyBytes);
    if (!parsed.ok) return rejectBadBody(req, res, parsed.cause);
    const body = parsed.value;

    const id = (typeof body.runId === "string" ? body.runId : url.searchParams.get("runId")) ?? "";
    if (id === "") return sendJson(res, 400, { error: "missing_run_id" });
    const record = registry.cancel(id);
    if (record === undefined) return sendJson(res, 404, { error: "run_not_found" });
    return sendJson(res, 200, record);
  }

  return {
    server,
    registry,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : options.port;
          deps.logger?.info({ host: options.host, port }, "api listening");
          resolve({ host: options.host, port });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        registry.cancelAll();
        server.close(() => resolve());
      }),
  };
}

function bearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/** Rate-limit key: the remote address, or "local" when the socket is gone. */
function remoteKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "local";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super("request body is not valid JSON");
    this.name = "InvalidJsonError";
  }
}

type BodyRead =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; cause: BodyTooLargeError | InvalidJsonError };

/** Answer a bad-body request, destroying the socket when the client is mid-send. */
function rejectBadBody(
  req: IncomingMessage,
  res: ServerResponse,
  cause: BodyTooLargeError | InvalidJsonError,
): void {
  if (cause instanceof BodyTooLargeError) {
    req.destroy();
    return sendJson(res, 413, { error: "body_too_large" });
  }
  return sendJson(res, 400, { error: "invalid_json" });
}

/**
 * Read and parse a JSON body, enforcing the byte cap **while streaming** so a
 * client cannot buffer us out of memory before the handler runs (ADR 011 §3).
 * An empty body is `{}`; a malformed body is reported, not silently defaulted.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > maxBytes) throw new BodyTooLargeError();
      chunks.push(buf);
    }
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) return { ok: false, cause };
    throw cause;
  }
  if (size === 0) return { ok: true, value: {} };
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, cause: new InvalidJsonError() };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, cause: new InvalidJsonError() };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
