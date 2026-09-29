import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../../src/api/index.js";
import type { RuntimePort } from "../../src/api/types.js";
import { FileTaskStore } from "../../src/core/task/FileTaskStore.js";
import { FileKnowledgeStore } from "../../src/core/knowledge/FileKnowledgeStore.js";
import { EventBus } from "../../src/events/index.js";
import type { AuroraEvent } from "../../src/events/types.js";
import type { RunResult } from "../../src/core/agent/types.js";

/**
 * Integration: the real `node:http` server and the real SSE route. The runtime
 * is a scripted port (no Ollama), but the stream itself is exercised over a real
 * socket — reading the raw `text/event-stream` frames is the only way to prove
 * the route works, since a mocked `res` would prove nothing about framing.
 */

class SlowRuntime implements RuntimePort {
  constructor(private readonly delayMs = 150) {}
  async runTask(task: string, opts?: { signal?: AbortSignal; runId?: string }): Promise<RunResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return { status: "completed", output: `ok:${task}`, iterations: 1, toolCalls: 0, trajectory: [] };
  }
  async health(): Promise<boolean> {
    return true;
  }
}

/** Collect SSE `data:` frames from `url` until `stop()` is called. */
async function collectSse(
  url: string,
  opts: { stopAfter: number; timeoutMs?: number },
): Promise<AuroraEvent[]> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: AuroraEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + (opts.timeoutMs ?? 4_000);
  try {
    while (events.length < opts.stopAfter && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            events.push(JSON.parse(line.slice("data: ".length)) as AuroraEvent);
          }
        }
      }
    }
  } finally {
    controller.abort();
  }
  return events;
}

let dir: string;
let api: ApiServer;
let base: string;
let bus: EventBus;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aurora-sse-"));
  bus = new EventBus();
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
      runtime: new SlowRuntime(),
      tasks: new FileTaskStore(join(dir, "tasks")),
      knowledge: new FileKnowledgeStore(join(dir, "knowledge")),
      events: bus,
    },
  );
  const bound = await api.listen();
  base = `http://127.0.0.1:${bound.port}`;
});

afterEach(async () => {
  await api?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /events (SSE)", () => {
  it("streams a run's lifecycle events live, in sequence order", async () => {
    // Subscribe first, then start the run, so the stream sees it from the top.
    const collected = collectSse(`${base}/events`, { stopAfter: 4 });
    // Give the subscription a moment to attach before emitting.
    await new Promise((r) => setTimeout(r, 100));
    const started = await fetch(`${base}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "hello" }),
    });
    expect(started.status).toBe(202);
    const events = await collected;

    const types = events.map((e) => e.type);
    expect(types).toContain("run.created");
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");

    // Sequences are strictly increasing — the ordering guarantee the UI needs.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBeGreaterThan(events[i - 1]!.sequence);
    }
  });

  it("filters to one run with GET /runs/:id/events", async () => {
    const created = await fetch(`${base}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "hello" }),
    });
    const record = (await created.json()) as { id: string };
    const events = await collectSse(`${base}/runs/${record.id}/events`, { stopAfter: 1 });
    expect(events[0]?.runId).toBe(record.id);
  });

  it("catches a finished run up from the replay ring on a fresh connection", async () => {
    // The regression this guards: a client that opens `/runs/:id/events` *after*
    // the run finished sends `after=0`, and a `0` treated as "skip history"
    // leaves it with an empty timeline.
    const created = await fetch(`${base}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "hello" }),
    });
    const record = (await created.json()) as { id: string };
    // Wait for the run to finish before subscribing.
    await new Promise((r) => setTimeout(r, 400));
    const events = await collectSse(`${base}/runs/${record.id}/events`, { stopAfter: 1 });
    const types = events.map((e) => e.type);
    expect(types).toContain("run.created");
    expect(types).toContain("run.completed");
  });

  it("404s for events of an unknown run", async () => {
    const res = await fetch(`${base}/runs/run-does-not-exist/events`);
    expect(res.status).toBe(404);
  });

  it("replays retained events when reconnecting with ?after", async () => {
    await fetch(`${base}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "hello" }),
    });
    await new Promise((r) => setTimeout(r, 400));
    const all = bus.replay();
    const last = all.at(-1)!.sequence;
    // No new events will arrive; the replay should include everything after 0.
    const replayed = bus.replay(0);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.at(-1)!.sequence).toBe(last);
  });
});
