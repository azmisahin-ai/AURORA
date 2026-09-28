import type {
  ChatInput,
  ChatOutput,
  LLMProvider,
  ToolCall,
} from "../../src/providers/llm/LLMProvider.js";
import type { ToolExecutionResult, ToolExecutor } from "../../src/core/agent/types.js";

/**
 * A scripted LLMProvider. This is NOT a mock of an internal function — it is a
 * test double for a *network* boundary, which is the one place a double is
 * justified. The provider interfaces it implements are the real ones.
 */
export class ScriptedLLM implements LLMProvider {
  readonly name = "scripted";
  readonly model = "scripted-model";
  readonly calls: ChatInput[] = [];
  private index = 0;

  constructor(private readonly script: ChatOutput[]) {}

  async chat(input: ChatInput): Promise<ChatOutput> {
    // Snapshot: the loop mutates and reuses its `messages` array across
    // iterations, so retaining the reference would make every recorded call
    // show the final state instead of the state at call time.
    this.calls.push({
      ...input,
      messages: input.messages.map((m) => ({
        ...m,
        ...(m.toolCalls ? { toolCalls: m.toolCalls.map((tc) => ({ ...tc })) } : {}),
      })),
    });
    const turn = this.script[this.index];
    this.index++;
    if (!turn) {
      // Once the script is exhausted, answer plainly so an over-eager loop
      // terminates instead of spinning.
      return { content: "script exhausted", toolCalls: [] };
    }
    return turn;
  }
}

export class ThrowingLLM implements LLMProvider {
  readonly name = "throwing";
  readonly model = "throwing-model";
  constructor(private readonly error: Error) {}
  async chat(): Promise<ChatOutput> {
    throw this.error;
  }
}

/** Stub tool executor backed by a map of name → result. */
export class StubTools implements ToolExecutor {
  readonly executed: ToolCall[] = [];
  constructor(private readonly results: Record<string, ToolExecutionResult>) {}

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.results, name);
  }

  async execute(call: ToolCall): Promise<ToolExecutionResult> {
    this.executed.push(call);
    return this.results[call.name] ?? { ok: false, observation: "no stub" };
  }
}

export function toolTurn(
  name: string,
  args: Record<string, unknown> = {},
): ChatOutput {
  return { content: "", toolCalls: [{ name, arguments: args }] };
}

export function finalTurn(content: string): ChatOutput {
  return { content, toolCalls: [] };
}
