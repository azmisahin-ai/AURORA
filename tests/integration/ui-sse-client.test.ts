import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { api } from "../../ui/lib/api.js";

/**
 * Integration: the UI's `fetch`-based SSE client against a real `node:http`
 * server. This is the one part of the live timeline that had no automated test
 * (ADR 012 records it as browser-smoke-only): `EventSource` cannot send an
 * `Authorization` header, so the client parses frames itself and reconnects
 * with `?after=<lastSequence>`. Both are exercised here over a real socket,
 * because a mocked `fetch` would prove nothing about the streaming path.
 *
 * The only shim is a relative-URL resolver: the browser resolves `/runs/...`
 * against the page origin, Node's `fetch` rejects a relative URL. That is a
 * harness detail, not a mock of the code under test.
 */

interface Frame {
  sequence: number;
  type: string;
}

/** SSE frame as the server writes it. */
function sse(event: Frame): string {
  return `data: ${JSON.stringify({ ...event, runId: "run-1", payload: null })}\n\n`;
}

let server: Server;
let base: string;
let realFetch: typeof fetch;
/** Query strings of every SSE request the server saw, in order. */
let requests: string[];

beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    // The client appends `?after=<seq>`, so match the path, not the whole URL.
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!path.endsWith("/events")) {
      res.writeHead(404).end();
      return;
    }
    requests.push(req.url ?? "");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    // Two frames then close: forces the client to reconnect and catch up.
    res.write(sse({ sequence: 1, type: "run.created" }));
    res.write(sse({ sequence: 2, type: "run.started" }));
    res.end();
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
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  server.close();
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

describe("ui SSE client (streamRunEvents)", () => {
  it("delivers frames in order and reconnects with ?after to catch up", async () => {
    const seen: Frame[] = [];
    const stop = api.streamRunEvents("run-1", { onEvent: (e: Frame) => seen.push(e) });
    try {
      // The server closes after two frames, so a third delivery proves the
      // client reconnected rather than the server having kept the socket open.
      await waitFor(() => seen.length >= 4);
    } finally {
      stop();
    }

    // Reconnect asked for what it already had, so the gap is replayed, not lost.
    expect(requests[0]).toContain("after=0");
    expect(requests[1]).toContain("after=2");
  });

  it("reports a gap when a replayed sequence skips ahead", async () => {
    // A second server whose second connection jumps 2 -> 5, as if the replay
    // ring had already evicted 3 and 4.
    server.close();
    await once(server, "close");
    let call = 0;
    server = createServer((req, res) => {
      call++;
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      if (call === 1) {
        res.write(sse({ sequence: 1, type: "run.created" }));
        res.write(sse({ sequence: 2, type: "run.started" }));
      } else {
        res.write(sse({ sequence: 5, type: "run.completed" }));
      }
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;

    const gaps: number[] = [];
    const seen: Frame[] = [];
    const stop = api.streamRunEvents("run-1", {
      onEvent: (e: Frame) => seen.push(e),
      onGap: (next: number) => gaps.push(next),
    });
    try {
      await waitFor(() => gaps.length >= 1);
    } finally {
      stop();
    }
    expect(gaps).toEqual([5]);
    expect(seen.map((e) => e.sequence)).toContain(5);
  });

  it("stops delivering after the disposer is called", async () => {
    const seen: Frame[] = [];
    const stop = api.streamRunEvents("run-1", { onEvent: (e: Frame) => seen.push(e) });
    await waitFor(() => seen.length >= 1);
    stop();
    const count = seen.length;
    // Give any in-flight reconnect a chance to (incorrectly) deliver more.
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.length).toBe(count);
  });
});
