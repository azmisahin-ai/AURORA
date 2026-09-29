import type { ChatMessage } from "../../providers/llm/LLMProvider.js";
import type { WorkingMemory } from "./types.js";

/**
 * The live transcript for one run.
 *
 * A thin wrapper rather than a bare array so the loop has one place that owns
 * "what is in context right now", and so tests can assert on the transcript
 * without reaching into loop internals.
 */
export class InMemoryWorkingMemory implements WorkingMemory {
  private buffer: ChatMessage[];

  constructor(initial: readonly ChatMessage[] = []) {
    this.buffer = [...initial];
  }

  append(message: ChatMessage): void {
    this.buffer.push(message);
  }

  messages(): ChatMessage[] {
    return [...this.buffer];
  }

  size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }
}
