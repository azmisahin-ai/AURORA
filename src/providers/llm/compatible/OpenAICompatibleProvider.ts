import {
  type ChatInput,
  type ChatOutput,
  LLMError,
  type LLMProvider,
  type ToolCall,
} from "../LLMProvider.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/**
 * Speaks the OpenAI `/v1/chat/completions` shape, which is the de-facto
 * interface for most hosted and self-hosted alternatives (vLLM, LM Studio,
 * OpenRouter, DeepSeek, Together, ...). No streaming in the MVP: the agent loop
 * consumes complete turns, and keeping this provider non-streaming avoids
 * duplicating SSE parsing per vendor.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    if (!opts.baseUrl) {
      throw new Error(
        "OPENAI_COMPATIBLE_BASE_URL is required for the openai-compatible provider",
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async chat(input: ChatInput): Promise<ChatOutput> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: input.messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc, i) => ({
            id: tc.id ?? `call_${i}`,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));
        }
        if (m.toolName !== undefined) msg.name = m.toolName;
        return msg;
      }),
    };

    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (input.options && Object.keys(input.options).length > 0) {
      Object.assign(body, input.options);
    }

    const res = await this.request("/chat/completions", body, input.signal);
    const json = (await res.json()) as ChatCompletionResponse;

    if (json.error) {
      throw new LLMError(`Provider error: ${json.error.message ?? "unknown"}`, {
        provider: this.name,
        retryable: false,
      });
    }

    const choice = json.choices?.[0];
    if (!choice) {
      throw new LLMError("Provider returned no choices", {
        provider: this.name,
        retryable: false,
      });
    }

    return {
      content: choice.message?.content ?? "",
      toolCalls: normalizeOpenAIToolCalls(choice.message?.tool_calls),
      ...(json.model !== undefined ? { model: json.model } : {}),
      ...(choice.finish_reason !== undefined
        ? { doneReason: choice.finish_reason }
        : {}),
      usage: {
        ...(json.usage?.prompt_tokens !== undefined
          ? { promptTokens: json.usage.prompt_tokens }
          : {}),
        ...(json.usage?.completion_tokens !== undefined
          ? { completionTokens: json.usage.completion_tokens }
          : {}),
      },
    };
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.request("/models", undefined, undefined, "GET");
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request(
    path: string,
    body: Record<string, unknown> | undefined,
    externalSignal?: AbortSignal,
    method: "GET" | "POST" = "POST",
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LLMError(
          `HTTP ${res.status} on ${path}${text ? `: ${text.slice(0, 300)}` : ""}`,
          {
            provider: this.name,
            status: res.status,
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
          ? `Request to ${path} timed out after ${this.timeoutMs}ms`
          : `Failed to reach provider at ${this.baseUrl}${path}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
        { provider: this.name, retryable: true, cause },
      );
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function normalizeOpenAIToolCalls(raw: OpenAIToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const name = entry?.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = entry?.function?.arguments;
    if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Leave args empty rather than failing the whole turn.
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
    calls.push({
      ...(entry?.id !== undefined ? { id: entry.id } : {}),
      name,
      arguments: args,
    });
  }
  return calls;
}
