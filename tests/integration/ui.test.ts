import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../../src/api/index.js";
import type { RuntimePort } from "../../src/api/types.js";
import { FileTaskStore } from "../../src/core/task/FileTaskStore.js";
import { FileKnowledgeStore } from "../../src/core/knowledge/FileKnowledgeStore.js";
import type { RunResult } from "../../src/core/agent/types.js";

/**
 * Integration: the Phase 10 static UI route and the three list endpoints, over
 * a real `node:http` server. The runtime is a scripted port, so no model is
 * needed (ADR 011 §2, ADR 012 §2).
 */

class FakeRuntime implements RuntimePort {
  async runTask(task: string): Promise<RunResult> {
    return { status: "completed", output: task, iterations: 1, toolCalls: 0, trajectory: [] };
  }
  async health(): Promise<boolean> {
    return true;
  }
}

let root: string;
let uiDir: string;
let outsideDir: string;
let api: ApiServer;
let base: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aurora-ui-"));
  uiDir = join(root, "ui");
  outsideDir = join(root, "outside");
  await mkdir(uiDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(join(uiDir, "index.html"), "<!doctype html><title>AURORA</title>");
  await writeFile(join(uiDir, "styles.css"), "body { color: red }");
  await mkdir(join(uiDir, "lib"), { recursive: true });
  await writeFile(join(uiDir, "lib", "dom.js"), "export const x = 1;");
  await writeFile(join(uiDir, "notes.txt"), "plain");
  // A file that lexically sits outside the UI root, and a symlink to it from
  // inside — the two escapes PathValidator exists to stop (ADR 004).
  await writeFile(join(outsideDir, "secret.txt"), "TOP SECRET");
  await symlink(join(outsideDir, "secret.txt"), join(uiDir, "escape.txt"));

  const tasks = new FileTaskStore(join(root, "tasks"));
  await tasks.create({ prompt: "write a haiku", id: "t1" });

  const knowledge = new FileKnowledgeStore(join(root, "knowledge"));
  await knowledge.write({
    kind: "topic",
    slug: "ollama-api",
    title: "Ollama API",
    content: "NDJSON",
    source: "https://docs.ollama.com/api/chat",
    verified: true,
  });
  await knowledge.write({ kind: "source", slug: "a-doc", title: "A doc", content: "x" });

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
    { runtime: new FakeRuntime(), tasks, knowledge, uiDir },
  );
  const bound = await api.listen();
  base = `http://127.0.0.1:${bound.port}`;
});

afterAll(async () => {
  await api.close();
  await rm(root, { recursive: true, force: true });
});

describe("static UI route", () => {
  it("serves index.html at / with a restrictive CSP", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    // The two directives that make an injected <script> inert and unable to
    // exfiltrate (ADR 012 §3). Asserted, not assumed.
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain("AURORA");
  });

  it("serves nested assets under /ui/*", async () => {
    const res = await fetch(`${base}/ui/lib/dom.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("serves CSS with the right content type", async () => {
    const res = await fetch(`${base}/ui/styles.css`);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("does not sniff an unknown extension as HTML", async () => {
    const res = await fetch(`${base}/ui/notes.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("rejects path traversal out of the UI root", async () => {
    for (const attempt of ["/ui/../outside/secret.txt", "/ui/%2e%2e/outside/secret.txt"]) {
      const res = await fetch(`${base}${attempt}`, { redirect: "manual" });
      // A normalising client/server may resolve it to a non-UI path, which is a
      // 404; what must never happen is 200 with the secret in the body.
      const body = await res.text();
      expect(body).not.toContain("TOP SECRET");
    }
  });

  it("refuses to follow a symlink that escapes the UI root", async () => {
    const res = await fetch(`${base}/ui/escape.txt`);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("404s a missing asset rather than falling back to the shell", async () => {
    const res = await fetch(`${base}/ui/nope.js`);
    expect(res.status).toBe(404);
  });

  it("is not served when no uiDir is configured", async () => {
    const bare = createApiServer(
      {
        host: "127.0.0.1",
        port: 0,
        token: "",
        maxBodyBytes: 1024,
        rateLimit: 0,
        rateRefill: 1,
        maxConcurrentRuns: 1,
        maxSyncMs: 1000,
      },
      {
        runtime: new FakeRuntime(),
        tasks: new FileTaskStore(join(root, "tasks2")),
        knowledge: new FileKnowledgeStore(join(root, "knowledge2")),
      },
    );
    const bound = await bare.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${bound.port}/`);
      expect(res.status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe("list endpoints (UI data)", () => {
  it("GET /runs returns the live registry history", async () => {
    const started = await fetch(`${base}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "hello" }),
    });
    expect(started.status).toBe(202);
    const created = await started.json();

    const res = await fetch(`${base}/runs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.some((r: { id: string }) => r.id === created.id)).toBe(true);
  });

  it("GET /tasks lists durable tasks and honours filters", async () => {
    const all = await (await fetch(`${base}/tasks`)).json();
    expect(all.results.map((t: { id: string }) => t.id)).toContain("t1");

    const queued = await (await fetch(`${base}/tasks?status=queued`)).json();
    expect(queued.results.every((t: { status: string }) => t.status === "queued")).toBe(true);

    const invalid = await fetch(`${base}/tasks?status=bogus`);
    expect(invalid.status).toBe(400);
  });

  it("GET /knowledge without a query lists entries; with q it searches", async () => {
    const listed = await (await fetch(`${base}/knowledge`)).json();
    expect(listed.results.length).toBeGreaterThanOrEqual(2);

    const topics = await (await fetch(`${base}/knowledge?kind=topic`)).json();
    expect(topics.results.every((e: { kind: string }) => e.kind === "topic")).toBe(true);

    const searched = await (await fetch(`${base}/knowledge/search?q=ollama`)).json();
    expect(searched.results.length).toBeGreaterThan(0);

    const badKind = await fetch(`${base}/knowledge?kind=bogus`);
    expect(badKind.status).toBe(400);
  });

  it("GET /knowledge/:kind/:slug returns the body for the detail view", async () => {
    const res = await fetch(`${base}/knowledge/topic/ollama-api`);
    expect(res.status).toBe(200);
    const entry = await res.json();
    expect(entry.content).toBe("NDJSON");
    expect(entry.source).toBe("https://docs.ollama.com/api/chat");

    expect((await fetch(`${base}/knowledge/topic/nope`)).status).toBe(404);
    expect((await fetch(`${base}/knowledge/bogus/ollama-api`)).status).toBe(400);
  });

  it("requires the token on data routes but not on the shell", async () => {
    const secured = createApiServer(
      {
        host: "127.0.0.1",
        port: 0,
        token: "s3cret",
        maxBodyBytes: 1024,
        rateLimit: 0,
        rateRefill: 1,
        maxConcurrentRuns: 1,
        maxSyncMs: 1000,
      },
      {
        runtime: new FakeRuntime(),
        tasks: new FileTaskStore(join(root, "tasks3")),
        knowledge: new FileKnowledgeStore(join(root, "knowledge3")),
        uiDir,
      },
    );
    const bound = await secured.listen();
    const root2 = `http://127.0.0.1:${bound.port}`;
    try {
      // Shell: public, so a browser navigation can load it (ADR 012 §2).
      expect((await fetch(`${root2}/`)).status).toBe(200);
      // Data: gated.
      expect((await fetch(`${root2}/tasks`)).status).toBe(401);
      expect((await fetch(`${root2}/runs`)).status).toBe(401);
      const ok = await fetch(`${root2}/tasks`, { headers: { Authorization: "Bearer s3cret" } });
      expect(ok.status).toBe(200);
    } finally {
      await secured.close();
    }
  });
});
