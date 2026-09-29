import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../../src/api/index.js";
import type { RuntimePort } from "../../src/api/types.js";
import { FileTaskStore } from "../../src/core/task/FileTaskStore.js";
import { FileKnowledgeStore } from "../../src/core/knowledge/FileKnowledgeStore.js";
import { SecretRedactor } from "../../src/security/SecretRedactor.js";
import type { RunResult } from "../../src/core/agent/types.js";

/**
 * Integration: the real `node:http` server, real task/knowledge stores on disk,
 * and a scripted runtime *port*. No Ollama is needed because the LLM sits behind
 * `RuntimePort`, which is the whole point of the port (ADR 011 §2).
 */

class FakeRuntime implements RuntimePort {
  delayMs = 0;
  constructor(private readonly output = "ok") {}
  async runTask(task: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (opts?.signal?.aborted) {
      return { status: "aborted", output: "", iterations: 0, toolCalls: 0, trajectory: [] };
    }
    return { status: "completed", output: `${this.output}:${task}`, iterations: 1, toolCalls: 0, trajectory: [] };
  }
  async health(): Promise<boolean> {
    return true;
  }
}

let dir: string;
let api: ApiServer;
let base: string;
let runtime: FakeRuntime;

async function start(overrides: Partial<Parameters<typeof createApiServer>[0]> = {}, withRedactor = false) {
  runtime = new FakeRuntime();
  const knowledge = new FileKnowledgeStore(join(dir, "knowledge"));
  await knowledge.write({
    kind: "topic",
    slug: "ollama-api",
    title: "Ollama API",
    content: "The chat endpoint returns NDJSON.",
    source: "https://docs.ollama.com/api/chat",
    verified: true,
  });

  api = createApiServer(
    {
      host: "127.0.0.1",
      port: 0,
      token: "",
      maxBodyBytes: 1024,
      rateLimit: 0,
      rateRefill: 1,
      maxConcurrentRuns: 2,
      maxSyncMs: 5_000,
      ...overrides,
    },
    {
      runtime,
      tasks: new FileTaskStore(join(dir, "tasks")),
      knowledge,
      ...(withRedactor ? { redactor: new SecretRedactor() } : {}),
    },
  );
  const bound = await api.listen();
  base = `http://127.0.0.1:${bound.port}`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aurora-api-"));
});

afterEach(async () => {
  await api?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("HTTP API", () => {
  it("GET /health is unauthenticated and reports ok", async () => {
    await start({ token: "secret" });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("requires the bearer token on every other route", async () => {
    await start({ token: "secret" });
    expect((await fetch(`${base}/agent/run`, { method: "POST", body: "{}" })).status).toBe(401);

    const bad = await fetch(`${base}/agent/run`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({ task: "hi" }),
    });
    expect(bad.status).toBe(401);

    const good = await fetch(`${base}/agent/run`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify({ task: "hi" }),
    });
    expect(good.status).toBe(202);
  });

  it("POST /agent/run returns 202 + runId, then GET /runs/:id shows the result", async () => {
    await start();
    const res = await fetch(`${base}/agent/run`, {
      method: "POST",
      body: JSON.stringify({ task: "hello" }),
    });
    expect(res.status).toBe(202);
    const record = (await res.json()) as { id: string; status: string };
    expect(record.id).toMatch(/^run-/);
    expect(record.status).toBe("running");

    await waitForStatus(record.id, "completed");
    const got = (await (await fetch(`${base}/runs/${record.id}`)).json()) as {
      status: string;
      result: { output: string };
    };
    expect(got.status).toBe("completed");
    expect(got.result.output).toBe("ok:hello");
  });

  it("?wait=1 runs inline and returns the finished result", async () => {
    await start();
    const res = await fetch(`${base}/agent/run?wait=1`, {
      method: "POST",
      body: JSON.stringify({ task: "sync" }),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as { status: string; result: { output: string } };
    expect(record.status).toBe("completed");
    expect(record.result.output).toBe("ok:sync");
  });

  it("POST /agent/cancel aborts a running run", async () => {
    await start();
    runtime.delayMs = 2_000;
    const started = (await (
      await fetch(`${base}/agent/run`, { method: "POST", body: JSON.stringify({ task: "slow" }) })
    ).json()) as { id: string };

    const cancel = await fetch(`${base}/agent/cancel`, {
      method: "POST",
      body: JSON.stringify({ runId: started.id }),
    });
    expect(cancel.status).toBe(200);
    await waitForStatus(started.id, "cancelled");
    expect((await fetch(`${base}/runs/${started.id}`).then((r) => r.json()) as { status: string }).status).toBe(
      "cancelled",
    );
  });

  it("rejects an oversized body with 413", async () => {
    await start({ maxBodyBytes: 64 });
    const res = await fetch(`${base}/agent/run`, {
      method: "POST",
      body: JSON.stringify({ task: "x".repeat(500) }),
    }).catch(() => undefined);
    // Either the server answered 413, or it destroyed the socket mid-send; both
    // are the intended refusal, and neither is a 2xx.
    if (res) expect(res.status).toBe(413);
  });

  it("rejects malformed JSON with 400", async () => {
    await start();
    const res = await fetch(`${base}/agent/run`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("rejects a missing task with 400 and unknown routes with 404", async () => {
    await start();
    expect((await fetch(`${base}/agent/run`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/runs/does-not-exist`)).status).toBe(404);
  });

  it("enforces the concurrency bound with 429", async () => {
    await start({ maxConcurrentRuns: 1 });
    runtime.delayMs = 2_000;
    const first = await fetch(`${base}/agent/run`, {
      method: "POST",
      body: JSON.stringify({ task: "a" }),
    });
    expect(first.status).toBe(202);
    const second = await fetch(`${base}/agent/run`, {
      method: "POST",
      body: JSON.stringify({ task: "b" }),
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "run_capacity", limit: 1 });
  });

  it("rate-limits requests per client with 429 + Retry-After", async () => {
    await start({ rateLimit: 2, rateRefill: 0.001 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${base}/health`)).status);
    // /health is exempt from the limiter (liveness must always answer).
    expect(statuses.every((s) => s === 200)).toBe(true);

    const search = () => fetch(`${base}/knowledge/search?q=chat`);
    expect((await search()).status).toBe(200);
    expect((await search()).status).toBe(200);
    const limited = await search();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  it("searches the knowledge store and returns provenance", async () => {
    await start();
    const res = await fetch(`${base}/knowledge/search?q=chat`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { slug: string; source: string; verified: boolean }[];
    };
    expect(body.results[0]?.slug).toBe("ollama-api");
    expect(body.results[0]?.source).toBe("https://docs.ollama.com/api/chat");
    expect(body.results[0]?.verified).toBe(true);
  });

  it("validates knowledge query parameters", async () => {
    await start();
    expect((await fetch(`${base}/knowledge/search`)).status).toBe(400);
    expect((await fetch(`${base}/knowledge/search?q=x&kind=bogus`)).status).toBe(400);
    expect((await fetch(`${base}/knowledge/search?q=x&limit=0`)).status).toBe(400);
  });

  it("serves a persisted task by id", async () => {
    await start();
    const store = new FileTaskStore(join(dir, "tasks"));
    const task = await store.create({ prompt: "durable work" });
    const res = await fetch(`${base}/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { prompt: string }).prompt).toBe("durable work");
    expect((await fetch(`${base}/tasks/missing`)).status).toBe(404);
  });

  it("scrubs credential shapes out of an error surfaced over HTTP", async () => {
    const leaking: RuntimePort = {
      runTask: async () => {
        throw new Error("provider rejected key sk-abcdef0123456789abcdef0123456789");
      },
      health: async () => true,
    };
    api = createApiServer(
      {
        host: "127.0.0.1",
        port: 0,
        token: "",
        maxBodyBytes: 1024,
        rateLimit: 0,
        rateRefill: 1,
        maxConcurrentRuns: 2,
        maxSyncMs: 5_000,
      },
      {
        runtime: leaking,
        tasks: new FileTaskStore(join(dir, "tasks")),
        knowledge: new FileKnowledgeStore(join(dir, "knowledge")),
        redactor: new SecretRedactor(),
      },
    );
    const bound = await api.listen();
    base = `http://127.0.0.1:${bound.port}`;

    const started = (await (
      await fetch(`${base}/agent/run`, { method: "POST", body: JSON.stringify({ task: "x" }) })
    ).json()) as { id: string };
    await waitForStatus(started.id, "failed");
    const record = (await (await fetch(`${base}/runs/${started.id}`)).json()) as { error: string };
    expect(record.error).not.toContain("sk-abcdef0123456789");
    expect(record.error).toContain("[REDACTED");
  });

  it("does not serve a public bind without a token", async () => {
    expect(() =>
      createApiServer(
        {
          host: "0.0.0.0",
          port: 0,
          token: "",
          maxBodyBytes: 1024,
          rateLimit: 0,
          rateRefill: 1,
          maxConcurrentRuns: 1,
          maxSyncMs: 1_000,
        },
        {
          runtime: new FakeRuntime(),
          tasks: new FileTaskStore(join(dir, "tasks")),
          knowledge: new FileKnowledgeStore(join(dir, "knowledge")),
        },
      ),
    ).toThrow(/AURORA_API_TOKEN/);
  });
});

async function waitForStatus(id: string, status: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = (await fetch(`${base}/runs/${id}`).then((r) => r.json())) as { status: string };
    if (record.status === status) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${id} never reached ${status}`);
}
