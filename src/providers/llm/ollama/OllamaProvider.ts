import {
  type ChatChunk,
  type ChatInput,
  type ChatOutput,
  LLMError,
  type LLMProvider,
} from "../LLMProvider.js";
import { type OllamaChatLine, normalizeToolCalls } from "./types.js";

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  /** Per-request timeout in ms. Defaults to 120s. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch (undici). */
  fetchImpl?: typeof fetch;
}

/**
 * Talks to a locally running (or remote) Ollama server over its REST API.
 *
 * Verified against https://docs.ollama.com/api/chat and
 * https://docs.ollama.com/api/streaming (accessed 2026-09-28): `/api/chat`
 * streams NDJSON by default, and `tool_calls` arrive inside `message` chunks.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly model: string;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async chat(input: ChatInput): Promise<ChatOutput> {
    // Non-streaming: one JSON object back. Simpler and sufficient for the
    // agent loop, which consumes complete turns.
    const body = this.buildBody(input, false);
    const res = await this.request("/api/chat", body, input.signal);
    const line = (await res.json()) as OllamaChatLine;

    if (line.error) {
      throw new LLMError(`Ollama error: ${line.error}`, {
        provider: this.name,
        retryable: false,
      });
    }

    return {
      content: line.message?.content ?? "",
      toolCalls: normalizeToolCalls(line),
      ...(line.model !== undefined ? { model: line.model } : {}),
      ...(line.done_reason !== undefined ? { doneReason: line.done_reason } : {}),
      usage: {
        ...(line.prompt_eval_count !== undefined
          ? { promptTokens: line.prompt_eval_count }
          : {}),
        ...(line.eval_count !== undefined ? { completionTokens: line.eval_count } : {}),
      },
    };
  }

  async *stream(input: ChatInput): AsyncIterable<ChatChunk> {
    const body = this.buildBody(input, true);
    const res = await this.request("/api/chat", body, input.signal);

    if (!res.body) {
      throw new LLMError("Ollama stream response has no body", {
        provider: this.name,
        retryable: true,
      });
    }

    let buffer = "";
    // `res.body` is a web ReadableStream (undici). Use its async iterator.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (raw === "") continue;

        const parsed = this.parseLine(raw);
        yield {
          contentDelta: parsed.message?.content ?? "",
          toolCalls: normalizeToolCalls(parsed),
          done: parsed.done === true,
          ...(parsed.done_reason !== undefined ? { doneReason: parsed.done_reason } : {}),
        };
      }
    }

    // Flush any trailing line that arrived without a final newline.
    const tail = buffer.trim();
    if (tail !== "") {
      const parsed = this.parseLine(tail);
      yield {
        contentDelta: parsed.message?.content ?? "",
        toolCalls: normalizeToolCalls(parsed),
        done: parsed.done === true,
        ...(parsed.done_reason !== undefined ? { doneReason: parsed.done_reason } : {}),
      };
    }
  }

  async listModels(): Promise<string[]> {
    const res = await this.request("/api/tags", undefined, undefined, "GET");
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    return (json.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.request("/api/tags", undefined, undefined, "GET");
      return res.ok;
    } catch {
      return false;
    }
  }

  private buildBody(input: ChatInput, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: input.messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolName !== undefined) msg.tool_name = m.toolName;
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        return msg;
      }),
      stream,
    };

    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (input.options && Object.keys(input.options).length > 0) {
      body.options = input.options;
    }
    return body;
  }

  private parseLine(raw: string): OllamaChatLine {
    let parsed: OllamaChatLine;
    try {
      parsed = JSON.parse(raw) as OllamaChatLine;
    } catch (cause) {
      throw new LLMError(`Malformed NDJSON line from Ollama: ${raw.slice(0, 200)}`, {
        provider: this.name,
        retryable: false,
        cause,
      });
    }
    if (parsed.error) {
      throw new LLMError(`Ollama error: ${parsed.error}`, {
        provider: this.name,
        retryable: false,
      });
    }
    return parsed;
  }

  private async request(
    path: string,
    body: Record<string, unknown> | undefined,
    externalSignal?: AbortSignal,
    method: "GET" | "POST" = "POST",
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Bridge an external abort signal into our internal controller.
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await safeText(res);
        throw new LLMError(
          `Ollama HTTP ${res.status} on ${path}${text ? `: ${text.slice(0, 300)}` : ""}`,
          {
            provider: this.name,
            status: res.status,
            // 5xx and 429 are worth retrying; 4xx generally are not.
            retryable: res.status >= 500 || res.status === 429,
          },
        );
      }
      return res;
    } catch (cause) {
      if (cause instanceof LLMError) throw cause;
      const aborted = controller.signal.aborted;
      throw new LLMError(
        aborted
          ? `Ollama request to ${path} timed out after ${this.timeoutMs}ms`
          : `Failed to reach Ollama at ${this.baseUrl}${path}: ${errorMessage(cause)}`,
        { provider: this.name, retryable: true, cause },
      );
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    // undici surfaces connection failures as TypeError("fetch failed") with a
    // nested cause; include it for actionable diagnostics.
    const nested = (cause as { cause?: unknown }).cause;
    if (nested instanceof Error) return `${cause.message} (${nested.message})`;
    return cause.message;
  }
  return String(cause);
}
