import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OllamaProvider } from "../../src/providers/llm/ollama/OllamaProvider.js";
import { LLMError } from "../../src/providers/llm/LLMProvider.js";

/**
 * These tests run a REAL HTTP server and make REAL fetch calls over the
 * loopback interface. The server is a stand-in for Ollama, not a mock of our
 * own code: we are exercising the actual HTTP client, NDJSON framing, and
 * error mapping in OllamaProvider.
 */

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

type Handler = (req: RecordedRequest, res: import("node:http").ServerResponse) => void;

async function startServer(handler: Handler): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
  server: Server;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown = undefined;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body: parsed,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const openServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (openServers.length > 0) {
    const close = openServers.pop();
    if (close) await close();
  }
});

async function withServer(handler: Handler) {
  const s = await startServer(handler);
  openServers.push(s.close);
  return s;
}

describe("OllamaProvider.chat", () => {
  it("sends a non-streaming chat request and parses the JSON reply", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "llama3.2",
          message: { role: "assistant", content: "merhaba" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 12,
          eval_count: 3,
        }),
      );
    });

    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "llama3.2" });
    const out = await provider.chat({
      messages: [{ role: "user", content: "Merhaba de" }],
    });

    expect(out.content).toBe("merhaba");
    expect(out.toolCalls).toEqual([]);
    expect(out.usage).toEqual({ promptTokens: 12, completionTokens: 3 });

    const req = s.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/api/chat");
    const body = req?.body as Record<string, unknown>;
    expect(body.model).toBe("llama3.2");
    expect(body.stream).toBe(false);
  });

  it("parses tool_calls with object arguments", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "llama3.2",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "read_file", arguments: { path: "a.txt" } } },
            ],
          },
          done: true,
        }),
      );
    });

    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "llama3.2" });
    const out = await provider.chat({ messages: [{ role: "user", content: "read" }] });
    expect(out.toolCalls).toEqual([
      { name: "read_file", arguments: { path: "a.txt" } },
    ]);
  });

  it("parses tool_calls whose arguments arrive as a JSON string", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "t", arguments: '{"x":1}' } },
            ],
          },
          done: true,
        }),
      );
    });
    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    const out = await provider.chat({ messages: [{ role: "user", content: "q" }] });
    expect(out.toolCalls[0]?.arguments).toEqual({ x: 1 });
  });

  it("surfaces an in-body error field as an LLMError", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "model not found" }));
    });
    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    await expect(provider.chat({ messages: [] })).rejects.toThrow(/model not found/);
  });

  it("maps HTTP 500 to a retryable LLMError", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal error");
    });
    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    const err = await provider.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).retryable).toBe(true);
    expect((err as LLMError).status).toBe(500);
  });

  it("maps HTTP 404 to a non-retryable LLMError", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    const err = (await provider.chat({ messages: [] }).catch((e) => e)) as LLMError;
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(404);
  });

  it("reports a connection failure as a retryable LLMError naming the URL", async () => {
    // Bind then immediately close to obtain a port that is certainly refused.
    const { baseUrl, close } = await startServer((_r, res) => res.end());
    await close();
    const provider = new OllamaProvider({ baseUrl, model: "m" });
    const err = (await provider.chat({ messages: [] }).catch((e) => e)) as LLMError;
    expect(err).toBeInstanceOf(LLMError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/Failed to reach Ollama/);
  });

  it("times out and reports a timeout error", async () => {
    const s = await withServer(() => {
      // Never respond.
    });
    const provider = new OllamaProvider({
      baseUrl: s.baseUrl,
      model: "m",
      timeoutMs: 60,
    });
    const err = (await provider.chat({ messages: [] }).catch((e) => e)) as LLMError;
    expect(err).toBeInstanceOf(LLMError);
    expect(err.message).toMatch(/timed out/);
  });

  it("forwards tools in the documented Ollama shape", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }));
    });
    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    await provider.chat({
      messages: [{ role: "user", content: "q" }],
      tools: [
        { name: "read_file", description: "read", parameters: { type: "object" } },
      ],
    });
    const body = s.requests[0]?.body as Record<string, unknown>;
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "read_file", description: "read", parameters: { type: "object" } },
      },
    ]);
  });
});

describe("OllamaProvider.stream (real NDJSON over HTTP)", () => {
  it("yields content deltas and terminates on done", async () => {
    const lines = [
      { model: "m", message: { role: "assistant", content: "Mer" }, done: false },
      { model: "m", message: { role: "assistant", content: "ha" }, done: false },
      { model: "m", message: { role: "assistant", content: "ba" }, done: false },
      { model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
    ];
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const line of lines) res.write(`${JSON.stringify(line)}\n`);
      res.end();
    });

    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    let text = "";
    let done = false;
    for await (const chunk of provider.stream({ messages: [{ role: "user", content: "q" }] })) {
      text += chunk.contentDelta;
      if (chunk.done) done = true;
    }
    expect(text).toBe("Merhaba");
    expect(done).toBe(true);

    const body = s.requests[0]?.body as Record<string, unknown>;
    expect(body.stream).toBe(true);
  });

  it("captures tool_calls inside a streamed chunk", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: false })}\n`);
      res.write(
        `${JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "get_weather", arguments: { format: "celsius" } } }],
          },
          done: false,
        })}\n`,
      );
      res.write(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: true })}\n`);
      res.end();
    });

    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    const collected: Array<{ name: string }> = [];
    for await (const chunk of provider.stream({ messages: [] })) {
      for (const tc of chunk.toolCalls) collected.push({ name: tc.name });
    }
    expect(collected).toEqual([{ name: "get_weather" }]);
  });

  it("reassembles a JSON line split across TCP chunks", async () => {
    const full = `${JSON.stringify({
      message: { role: "assistant", content: "split-line" },
      done: true,
    })}\n`;
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      // Write in two fragments with a pause so they land in separate reads.
      res.write(full.slice(0, 10));
      setTimeout(() => res.end(full.slice(10)), 20);
    });

    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    let text = "";
    for await (const chunk of provider.stream({ messages: [] })) text += chunk.contentDelta;
    expect(text).toBe("split-line");
  });

  it("throws an LLMError on a malformed NDJSON line", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end("this is not json\n");
    });
    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    await expect(async () => {
      for await (const _ of provider.stream({ messages: [] })) {
        // drain
      }
    }).rejects.toThrow(/Malformed NDJSON/);
  });
});

describe("OllamaProvider.listModels / health", () => {
  it("lists models from /api/tags", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.2" }, { name: "qwen3" }] }));
    });
    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    expect(await provider.listModels()).toEqual(["llama3.2", "qwen3"]);
  });

  it("health() is true when the server responds", async () => {
    const s = await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
    });
    const provider = new OllamaProvider({ baseUrl: s.baseUrl, model: "m" });
    expect(await provider.health()).toBe(true);
  });

  it("health() is false when the server is unreachable", async () => {
    const { baseUrl, close } = await startServer((_r, res) => res.end());
    await close();
    const provider = new OllamaProvider({ baseUrl, model: "m" });
    expect(await provider.health()).toBe(false);
  });
});
