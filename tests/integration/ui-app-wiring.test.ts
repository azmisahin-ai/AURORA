// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Integration: the `app.js` event wiring (M0/CAP-004) under jsdom against a real
 * `node:http` server. ADR 012 recorded this as the last browser-smoke-only path
 * — which panel mounts the live timeline and when the stream starts and stops.
 * The pure rules and the SSE client already have tests; this proves the module
 * actually calls them and tears the subscription down.
 *
 * `app.js` runs `boot()` on import, so each test re-imports it fresh against a
 * DOM built from the real `ui/index.html`. The only shims are the ones a browser
 * provides and jsdom does not: a relative-URL resolver for `fetch`, and
 * `sessionStorage`. No module under test is mocked.
 */

const uiDir = resolve(process.cwd(), "ui");
const html = readFileSync(resolve(uiDir, "index.html"), "utf8");
/** The `<body>` of the real shell, so ids match what `boot()` looks up. */
const bodyHtml = html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("</body>"));

let server: Server;
let base: string;
let realFetch: typeof fetch;
/** Monotonic across tests, so an abort from a previous test's server cannot be
 * mistaken for this test's — the bug that made the first version flaky. */
let nextConnId = 1;
/** Connections opened, and ones the client abandoned, for the *current* test. */
let opened: number[];
let aborted: Set<number>;
/** Set by a test to script the run-events response. */
let onEvents: (res: import("node:http").ServerResponse) => void;

beforeEach(async () => {
  opened = [];
  aborted = new Set();
  onEvents = (res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.write('data: {"sequence":1,"type":"run.created","runId":"run-1","payload":{}}\n\n');
    res.write('data: {"sequence":2,"type":"run.completed","runId":"run-1","payload":{}}\n\n');
    // Stay open, like a live stream.
  };

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/runs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ id: "run-1", task: "hello", status: "running" }] }));
      return;
    }
    if (url.pathname === "/runs/run-1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "run-1", task: "hello", status: "running", result: null }));
      return;
    }
    if (url.pathname === "/runs/run-1/events") {
      const id = nextConnId++;
      opened.push(id);
      // A `close` on a response the server did not end means the client aborted
      // — the observable signal that `stopEventStream()` actually fired.
      res.on("close", () => {
        if (!res.writableEnded) aborted.add(id);
      });
      onEvents(res);
      return;
    }
    if (url.pathname === "/tasks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? base + input : input;
    return realFetch(url as RequestInfo, init);
  }) as typeof fetch;

  document.body.innerHTML = bodyHtml;
  // jsdom has no sessionStorage; `api.js` guards with try/catch, but the UI
  // reads it on boot, so give it a real one.
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: (() => {
      const map = new Map<string, string>();
      return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
      };
    })(),
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  server.close();
  server.closeAllConnections?.();
  await once(server, "close");
});

/** Wait until `predicate` holds, or fail the test. */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Import `app.js` fresh (its `boot()` runs on import) and wait for first paint. */
async function bootUi(): Promise<void> {
  vi.resetModules();
  await import(resolve(uiDir, "app.js"));
  // `boot()` calls `selectView("tasks")` synchronously and then `refresh()`.
  await waitFor(() => document.getElementById("conn-status")!.textContent === "connected");
}

/** Click the Agents tab and view the first run, as an operator would. */
async function openRunDetail(): Promise<void> {
  const agentsTab = document.querySelector<HTMLElement>('[data-view="agents"]')!;
  agentsTab.click();
  await waitFor(() => document.querySelectorAll("#content tbody tr").length > 0);
  const view = [...document.querySelectorAll<HTMLButtonElement>("#content button")].find(
    (b) => b.textContent === "view",
  )!;
  view.click();
  await waitFor(() => document.querySelector("#detail ul.events") !== null);
}

describe("app.js event wiring (M0/CAP-004)", () => {
  it("mounts the live timeline when a run is opened", async () => {
    await bootUi();
    await openRunDetail();

    await waitFor(() => document.querySelectorAll("#detail ul.events li.ev").length >= 2);
    const items = [...document.querySelectorAll("#detail ul.events li.ev")];
    expect(items[0]!.textContent).toContain("run.created");
    expect(items[1]!.textContent).toContain("run.completed");
    expect(opened.length).toBe(1);
  });

  it("stops the stream when the operator leaves the Agents view", async () => {
    await bootUi();
    await openRunDetail();
    await waitFor(() => document.querySelectorAll("#detail ul.events li.ev").length >= 2);

    // Back to Tasks: the subscription must be torn down. The observable proof is
    // the server seeing the client abort — not merely that the timeline vanished
    // (a leaked stream would also stop being rendered, but would keep running).
    document.querySelector<HTMLElement>('[data-view="tasks"]')!.click();
    await waitFor(() => opened.some((id) => aborted.has(id)));
    expect(opened.length).toBe(1);
    expect(document.querySelector("#detail ul.events")).toBeNull();
  });

  it("marks the timeline when a replayed sequence skips ahead", async () => {
    // Second connection jumps 2 -> 5, as if the ring had evicted 3 and 4.
    onEvents = (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      if (opened.length === 1) {
        res.write('data: {"sequence":1,"type":"run.created","runId":"run-1","payload":{}}\n\n');
        res.write('data: {"sequence":2,"type":"run.completed","runId":"run-1","payload":{}}\n\n');
        res.end();
      } else {
        res.write('data: {"sequence":5,"type":"run.failed","runId":"run-1","payload":{}}\n\n');
      }
    };
    await bootUi();
    await openRunDetail();

    // The gap banner is set from `onGap`; the ring dropped 3 and 4.
    await waitFor(() =>
      (document.getElementById("detail")!.textContent ?? "").includes("Some events were dropped"),
    );
    expect(document.querySelector("#detail ul.events li.ev-gap")).not.toBeNull();
  });
});
