import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider } from "../../src/providers/llm/compatible/OpenAICompatibleProvider.js";
import { LLMError } from "../../src/providers/llm/LLMProvider.js";

/** Real HTTP server standing in for an OpenAI-compatible endpoint. */

interface Recorded {
  method: string;
  url: string;
  headers: import("node:http").IncomingHttpHeaders;
  body: unknown;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

async function start(handler: (req: Recorded, res: import("node:http").ServerResponse) => void) {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const rec: Recorded = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      };
      requests.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  open.push(close);
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

describe("OpenAICompatibleProvider", () => {
  it("requires a base URL", () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          baseUrl: "",
          model: "m",
        }),
    ).toThrow(/OPENAI_COMPATIBLE_BASE_URL/);
  });

  it("parses a normal completion", async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "gpt-x",
          choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );
    });
    const p = new OpenAICompatibleProvider({ baseUrl: s.baseUrl, model: "m" });
    const out = await p.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out.content).toBe("hi there");
    expect(out.doneReason).toBe("stop");
    expect(out.usage).toEqual({ promptTokens: 5, completionTokens: 2 });

    expect(s.requests[0]?.url).toBe("/chat/completions");
  });

  it("sends the API key as a bearer token", async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: s.baseUrl,
      apiKey: "secret-key",
      model: "m",
    });
    await p.chat({ messages: [] });
    expect(s.requests[0]?.headers.authorization).toBe("Bearer secret-key");
  });

  it("omits the Authorization header when no key is configured", async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    const p = new OpenAICompatibleProvider({ baseUrl: s.baseUrl, model: "m" });
    await p.chat({ messages: [] });
    expect(s.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("parses tool_calls with a JSON-string arguments payload", async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
    });
    const p = new OpenAICompatibleProvider({ baseUrl: s.baseUrl, model: "m" });
    const out = await p.chat({ messages: [] });
    expect(out.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
    ]);
  });

  it("surfaces an error body", async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    });
    const p = new OpenAICompatibleProvider({ baseUrl: s.baseUrl, model: "m" });
    await expect(p.chat({ messages: [] })).rejects.toThrow(/bad key/);
  });

  it("maps HTTP 429 to a retryable error", async () => {
    const s = await start((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    const p = new OpenAICompatibleProvider({ baseUrl: s.baseUrl, model: "m" });
    const err = (await p.chat({ messages: [] }).catch((e) => e)) as LLMError;
    expect(err).toBeInstanceOf(LLMError);
    expect(err.retryable).toBe(true);
  });

  it("reports no choices as an error", async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [] }));
    });
    const p = new OpenAICompatibleProvider({ baseUrl: s.baseUrl, model: "m" });
    await expect(p.chat({ messages: [] })).rejects.toThrow(/no choices/i);
  });
});
