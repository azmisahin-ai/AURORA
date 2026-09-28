import type { ToolCall } from "../LLMProvider.js";

/** Shape of a single NDJSON line from Ollama's `/api/chat`. */
export interface OllamaChatLine {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        description?: string;
        arguments?: unknown;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Normalise Ollama's tool-call shape into AURORA's. */
export function normalizeToolCalls(line: OllamaChatLine): ToolCall[] {
  const raw = line.message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const fn = entry?.function;
    if (!fn?.name) continue;
    calls.push({
      name: fn.name,
      arguments: coerceArguments(fn.arguments),
    });
  }
  return calls;
}

/**
 * Ollama usually returns arguments as an object, but some models emit a JSON
 * string. Accept both; fall back to an empty object on malformed input.
 */
function coerceArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return {};
}
