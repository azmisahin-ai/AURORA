/**
 * LLM provider abstractions. These types are owned by AURORA, not by any vendor
 * SDK, so `core` never depends on a concrete provider (ADR 003).
 *
 * Vendor-specific knobs (e.g. Ollama's `think`) go in the opaque `options` bag
 * so they cannot leak into core logic.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that request tool execution. */
  toolCalls?: ToolCall[];
  /** Present on tool-role messages, identifying which call this answers. */
  toolName?: string;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** JSON-Schema-like description of a tool offered to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ChatInput {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Opaque, provider-specific generation options. */
  options?: Record<string, unknown>;
  /** Abort signal so the caller can enforce a global timeout. */
  signal?: AbortSignal;
}

export interface ChatOutput {
  content: string;
  toolCalls: ToolCall[];
  model?: string;
  doneReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface ChatChunk {
  /** Incremental content delta. */
  contentDelta: string;
  /** Tool calls observed in this chunk (may be empty). */
  toolCalls: ToolCall[];
  done: boolean;
  doneReason?: string;
}

export interface LLMProvider {
  /** Identifier used in logs and error messages, e.g. "ollama". */
  readonly name: string;
  /** Provider's default model, if any. */
  readonly model: string;

  chat(input: ChatInput): Promise<ChatOutput>;
  stream?(input: ChatInput): AsyncIterable<ChatChunk>;
  listModels?(): Promise<string[]>;
  health?(): Promise<boolean>;
}

/** Raised when a provider cannot fulfil a request. Carries a retryability hint. */
export class LLMError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    opts: { provider: string; retryable?: boolean; status?: number; cause?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "LLMError";
    this.provider = opts.provider;
    this.retryable = opts.retryable ?? false;
    if (opts.status !== undefined) this.status = opts.status;
  }
}
