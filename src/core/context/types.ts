/**
 * Context-management types (ADR 009).
 *
 * Context growth is the failure the memory research names directly: "traditional
 * concatenation of dialogue history leads to memory interference and
 * computational inefficiency" (`docs/research/memory-systems.md` §2). The loop
 * that appends every message forever is therefore a bug, not a default. These
 * types describe the bounded shape a provider call is built from.
 */

import type { ChatMessage } from "../../providers/llm/LLMProvider.js";

/**
 * Estimates the token cost of messages. A *heuristic*, deliberately: AURORA is
 * provider-independent and has no universal tokenizer (and Ollama models each
 * ship their own). The number is used only to decide when to compact — never
 * for billing or for a hard API limit — so a heuristic is honest here as long
 * as it is labelled as one and rounds conservatively.
 */
export interface TokenEstimator {
  /** Estimated tokens for one message. */
  estimateMessage(message: ChatMessage): number;
  /** Estimated tokens for a transcript. */
  estimateMessages(messages: readonly ChatMessage[]): number;
  /** Estimated tokens for a bare string (a candidate replacement, say). */
  estimateText(text: string): number;
}

export interface ContextPlan {
  /** The messages to actually send, in order. */
  messages: ChatMessage[];
  /** Tokens before compaction, by the estimator. */
  originalTokens: number;
  /** Tokens after compaction. */
  finalTokens: number;
  /** The budget this plan was built against. */
  budget: number;
  /**
   * True when the plan is still above budget after every legal elision. The
   * call proceeds — dropping the task or a tool call would be worse than a long
   * prompt — but the caller can report it instead of pretending it fit.
   */
  overBudget: boolean;
  /** What was done, for the trajectory and the log. */
  actions: ContextAction[];
}

export interface ContextAction {
  kind: "elide-turns" | "truncate-observation" | "notice" | "none";
  /** Messages removed from the middle of the transcript. */
  elidedMessages?: number;
  /** Observations shortened, with the characters removed. */
  truncatedObservations?: number;
  truncatedChars?: number;
  note?: string;
}
