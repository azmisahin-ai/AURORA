import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { AllowAllGate, DenyAllGate, type ConfirmationGate } from "../security/ConfirmationGate.js";
import { KeyedRateLimiter } from "../security/RateLimiter.js";
import { PathValidator, PathValidationError } from "../security/PathValidator.js";
import type { SecretRedactor } from "../security/SecretRedactor.js";
import type { FileKnowledgeStore } from "../core/knowledge/FileKnowledgeStore.js";
import type { FileTaskStore } from "../core/task/FileTaskStore.js";
import type { TaskStatus } from "../core/task/types.js";
import type { ApiServerOptions, RuntimePort } from "./types.js";
import { RunCapacityError, RunRegistry } from "./RunRegistry.js";

/** Dependencies the server is given; nothing here is constructed from the network. */
export interface ApiDeps {
  runtime: RuntimePort;
  tasks: FileTaskStore;
  knowledge: FileKnowledgeStore;
  /**
   * Directory holding the Phase 10 UI. When set, its files are served on
   * `GET /` and `GET /ui/*` (same-origin with the API). When absent, no static
   * route exists — the API is exactly the Phase 9 surface.
   */
  uiDir?: string;
  logger?: import("pino").Logger;
  /**
   * Applied to error strings that leave over HTTP. Log redaction (Phase 8) does
   * not cover a response body, so a provider error quoting an API key must be
   * scrubbed here too.
   */
  redactor?: SecretRedactor;
  /**
   * Event bus backing the live stream (`GET /runs/:id/events`, `GET /events`).
   * When absent, those routes 404 — the API is exactly the pre-M0 surface.
   */
  events?: import("../events/index.js").EventBus;
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

  // One validator for the static UI, rooted at `uiDir`. Built once, not per
  // request; every request still re-runs the containment (and symlink) check.
  const uiValidator = deps.uiDir !== undefined ? new PathValidator([deps.uiDir]) : undefined;

  const registry = new RunRegistry({
    runtime: deps.runtime,
    maxConcurrentRuns: options.maxConcurrentRuns,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps.events !== undefined ? { events: deps.events } : {}),
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

    // The UI shell is public for the same reason health is: a browser cannot
    // attach an Authorization header to a top-level navigation, so a token-gated
    // index.html is unreachable without putting the token in a URL, which every
    // proxy would log. The shell carries no data; every data route below still
    // requires the token (ADR 012 §2).
    if (deps.uiDir !== undefined && (path === "/" || path === "/ui" || path.startsWith("/ui/"))) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      return serveStatic(path, res);
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
    const runEventsMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
    const knowledgeMatch = /^\/knowledge\/([^/]+)\/([^/]+)$/.exec(path);

    // Live event stream (M0, CAP-004). Server-Sent Events, not WebSockets: the
    // traffic is one-way and SSE survives proxies, reconnects automatically,
    // and needs no extra dependency. `GET /events` streams everything;
    // `GET /runs/:id/events` filters to one run.
    if (path === "/events" || runEventsMatch) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      if (deps.events === undefined) return sendJson(res, 404, { error: "not_found" });
      const runId = runEventsMatch ? decodeURIComponent(runEventsMatch[1]!) : undefined;
      if (runId !== undefined && registry.get(runId) === undefined) {
        return sendJson(res, 404, { error: "run_not_found" });
      }
      const after = Number(url.searchParams.get("after") ?? "0");
      return streamEvents(res, deps.events, Number.isFinite(after) ? after : 0, runId, req);
    }

    if (path === "/knowledge/search" || path === "/knowledge") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      // `/knowledge` without `q` is the browser's list view; with `q` it is a
      // search. One route, because the UI and the CLI ask the same store the
      // same way (ADR 012 §2).
      if (path === "/knowledge" && !url.searchParams.has("q") && !url.searchParams.has("text")) {
        return handleKnowledgeList(url, res);
      }
      return handleKnowledgeSearch(url, res);
    }
    if (path === "/runs") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      return sendJson(res, 200, { results: registry.list() });
    }
    if (path === "/tasks") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      return handleTaskList(url, res);
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
    if (knowledgeMatch) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      const kind = decodeURIComponent(knowledgeMatch[1]!);
      if (!["topic", "source", "research"].includes(kind)) {
        return sendJson(res, 400, { error: "invalid_kind" });
      }
      // A detail view needs the body, which the list route deliberately omits
      // (it is a display path, not a fetch-everything path). The response is the
      // flat metadata shape plus `content`/`path`, so the UI renders one shape.
      const entry = await deps.knowledge.read(
        kind as "topic" | "source" | "research",
        decodeURIComponent(knowledgeMatch[2]!),
      );
      if (entry === null) return sendJson(res, 404, { error: "knowledge_not_found" });
      return sendJson(res, 200, { ...entry.metadata, content: entry.content, path: entry.path });
    }
    return sendJson(res, 404, { error: "not_found" });
  }

  async function handleKnowledgeList(url: URL, res: ServerResponse): Promise<void> {
    const kind = url.searchParams.get("kind") ?? undefined;
    if (kind !== undefined && !["topic", "source", "research"].includes(kind)) {
      return sendJson(res, 400, { error: "invalid_kind" });
    }
    const topic = url.searchParams.get("topic") ?? undefined;
    const entries = await deps.knowledge.list({
      ...(kind !== undefined ? { kind: kind as "topic" | "source" | "research" } : {}),
      ...(topic !== undefined && topic !== "" ? { topic } : {}),
    });
    return sendJson(res, 200, { results: entries });
  }

  async function handleTaskList(url: URL, res: ServerResponse): Promise<void> {
    const status = url.searchParams.get("status") ?? undefined;
    const statuses = ["queued", "running", "waiting", "completed", "failed", "cancelled"];
    if (status !== undefined && !statuses.includes(status)) {
      return sendJson(res, 400, { error: "invalid_status" });
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return sendJson(res, 400, { error: "invalid_limit" });
    }
    const tag = url.searchParams.get("tag") ?? undefined;
    const tasks = await deps.tasks.list({
      ...(status !== undefined ? { status: status as TaskStatus } : {}),
      ...(tag !== undefined && tag !== "" ? { tag } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return sendJson(res, 200, { results: tasks });
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

  async function serveStatic(path: string, res: ServerResponse): Promise<void> {
    const uiDir = deps.uiDir!;
    // `/` and `/ui` map to index.html; `/ui/<file>` maps to that file. The path
    // from the network goes through the *same* PathValidator the filesystem
    // tools use (ADR 004) — containment is a solved problem here, not a new one.
    // `resolveReal`, not `resolve`: a file that is *lexically* inside `ui/` can
    // still be a symlink to somewhere outside it, and this route is reachable
    // without a token. The symlink check is the reason this is async.
    const rel = path === "/" || path === "/ui" ? "index.html" : path.slice("/ui/".length);
    let absolute: string;
    try {
      absolute = await uiValidator!.resolveReal(rel, uiDir);
    } catch (cause) {
      if (cause instanceof PathValidationError) return sendJson(res, 400, { error: "invalid_path" });
      throw cause;
    }

    let body: Buffer;
    try {
      body = await readFile(absolute);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return sendJson(res, 404, { error: "not_found" });
      throw cause;
    }

    res.writeHead(200, {
      "Content-Type": contentTypeFor(absolute),
      "Content-Length": body.byteLength,
      "X-Content-Type-Options": "nosniff",
      // Defense-in-depth beside text-only rendering (ADR 012 §3): with
      // `script-src 'self'` and no inline scripts, an injected <script> could
      // not execute even if the structural layer were bypassed; `connect-src
      // 'self'` means a successful injection could not exfiltrate either.
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "connect-src 'self'; img-src 'self' data:; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'; object-src 'none'",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
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

/**
 * Content type by extension, from a fixed allowlist. A missing mapping is
 * `text/plain` (never sniffed as HTML) — an unrecognised file should not be
 * able to become a document.
 */
function contentTypeFor(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "text/plain; charset=utf-8";
  }
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

/**
 * Stream events as Server-Sent Events until the client disconnects (M0,
 * CAP-004).
 *
 * Backpressure is the client's problem, by design: an SSE connection that
 * cannot keep up is dropped (`res.write` returns false and we stop the
 * subscription) rather than buffered without bound in the server. A stalled
 * browser tab must never grow the agent's memory.
 *
 * A heartbeat comment every 15s keeps intermediaries from closing an idle
 * stream — a run can be quiet for a minute while a model thinks.
 */
function streamEvents(
  res: ServerResponse,
  bus: import("../events/index.js").EventBus,
  after: number,
  runId: string | undefined,
  req: IncomingMessage,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  // Tell the client how long to wait before reconnecting, and echo a comment so
  // proxies flush the headers immediately.
  res.write("retry: 3000\n\n");

  let open = true;
  const write = (event: unknown): void => {
    if (!open) return;
    const ok = res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (!ok) {
      // Subscriber is not draining; close rather than buffer. The client will
      // reconnect with `?after=<lastSequence>` and catch up from the replay ring.
      cleanup();
      res.end();
    }
  };

  const unsubscribe = bus.subscribe((event) => {
    if (runId !== undefined && event.runId !== runId) return;
    write(event);
  }, after);

  const heartbeat = setInterval(() => {
    if (open) res.write(": ping\n\n");
  }, 15_000);

  const cleanup = (): void => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on("close", () => {
    cleanup();
  });
  res.on("close", () => {
    cleanup();
  });
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
