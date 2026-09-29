import type { ChatMessage } from "../../providers/llm/LLMProvider.js";
import type { TokenEstimator } from "./types.js";

/**
 * A character-based token estimator.
 *
 * Rationale for `chars / 4`: English text averages ~4 characters per token
 * across common BPE vocabularies, and JSON tool output — the bulk of a coding
 * agent's history — sits at the same order. This is documented as a heuristic
 * on the interface (`TokenEstimator`); it exists to decide *when to compact*,
 * not to enforce a provider's real limit, so precision is not the goal.
 *
 * Deliberately **conservative**: it rounds each message up and adds a small
 * per-message overhead for role markers and chat-template tokens, so it tends
 * to over-count. Over-counting compacts slightly early, which is safe;
 * under-counting would silently overrun the budget, which is not.
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  private readonly charsPerToken: number;
  private readonly perMessageOverhead: number;

  constructor(opts: { charsPerToken?: number; perMessageOverhead?: number } = {}) {
    this.charsPerToken = opts.charsPerToken ?? 4;
    this.perMessageOverhead = opts.perMessageOverhead ?? 4;
  }

  estimateText(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }

  estimateMessage(message: ChatMessage): number {
    let tokens = this.perMessageOverhead + this.estimateText(message.content);
    // Tool calls are serialised as JSON in the prompt; count their arguments so
    // a few large calls are not invisible to the budget.
    for (const call of message.toolCalls ?? []) {
      tokens += this.perMessageOverhead + this.estimateText(JSON.stringify(call.arguments));
    }
    return tokens;
  }

  estimateMessages(messages: readonly ChatMessage[]): number {
    let total = 0;
    for (const message of messages) total += this.estimateMessage(message);
    return total;
  }
}

export const defaultTokenEstimator = new HeuristicTokenEstimator();
