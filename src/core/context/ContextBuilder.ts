import type { ChatMessage } from "../../providers/llm/LLMProvider.js";
import { defaultTokenEstimator } from "./TokenEstimator.js";
import type { ContextAction, ContextPlan, TokenEstimator } from "./types.js";

export interface ContextBuilderOptions {
  /** Hard token budget for the messages handed to the provider. */
  budget: number;
  estimator?: TokenEstimator;
  /**
   * A single tool observation larger than this is shortened before any turn is
   * elided. Tool output is the bulk of an agent transcript, and a request to
   * read a 1 MB file would otherwise evict the whole conversation.
   */
  maxObservationTokens?: number;
  /**
   * Messages at the head that are never elided. The leading run of
   * `system`/`user` messages — the system prompt, any session recall, and the
   * original task — is the run's identity: dropping either produces a plausible
   * answer to the wrong question.
   */
  protectedHead?: number;
  /** Tokens reserved for the model's own reply. Defaults to 0. */
  reserveForReply?: number;
}

interface Turn {
  messages: ChatMessage[];
}

const DEFAULT_MAX_OBSERVATION_TOKENS = 2_000;

/**
 * Builds a provider-ready message list that respects a token budget.
 *
 * The failure it prevents is concrete: an agent loop that appends every
 * observation grows without bound and eventually either overflows the model's
 * window or drowns the task in stale tool output (research §2, "memory
 * interference"). This class is the single place that decides what to keep.
 *
 * Order of operations, cheapest and least lossy first:
 *  1. In budget → return the transcript untouched.
 *  2. Shorten oversized individual observations (keeps their head and tail).
 *  3. Elide whole turns from the middle, oldest first, keeping a protected head
 *     and the most recent tail.
 *  4. If still over budget, report it (`overBudget`) rather than dropping
 *     something load-bearing.
 */
export class ContextBuilder {
  private readonly budget: number;
  private readonly estimator: TokenEstimator;
  private readonly maxObservationTokens: number;
  private readonly protectedHead: number | undefined;
  private readonly reserveForReply: number;

  constructor(opts: ContextBuilderOptions) {
    if (!Number.isFinite(opts.budget) || opts.budget <= 0) {
      throw new Error("ContextBuilder budget must be a positive number");
    }
    this.budget = Math.floor(opts.budget);
    this.estimator = opts.estimator ?? defaultTokenEstimator;
    this.maxObservationTokens = opts.maxObservationTokens ?? DEFAULT_MAX_OBSERVATION_TOKENS;
    this.protectedHead = opts.protectedHead;
    this.reserveForReply = opts.reserveForReply ?? 0;
  }

  /**
   * The protected head is the leading run of `system`/`user` messages. Counted
   * rather than configured: the transcript always opens with the system prompt,
   * an optional session-recall user message, and the task, so a fixed count
   * would silently stop protecting the task the moment recall was added.
   */
  private headSize(messages: readonly ChatMessage[]): number {
    if (this.protectedHead !== undefined) return this.protectedHead;
    let n = 0;
    while (n < messages.length && (messages[n]!.role === "system" || messages[n]!.role === "user")) {
      n++;
    }
    return n;
  }

  build(messages: readonly ChatMessage[]): ContextPlan {
    const effectiveBudget = Math.max(1, this.budget - this.reserveForReply);
    const originalTokens = this.estimator.estimateMessages(messages);
    const actions: ContextAction[] = [];

    if (originalTokens <= effectiveBudget) {
      return {
        messages: [...messages],
        originalTokens,
        finalTokens: originalTokens,
        budget: this.budget,
        overBudget: false,
        actions: [{ kind: "none" }],
      };
    }

    // Step 2: shorten oversized observations. The protected head is left
    // alone — it is already bounded and must survive verbatim.
    const headSize = this.headSize(messages);
    let working = messages.map((message, index) =>
      index < headSize ? message : truncateObservation(message, this.estimator, this.maxObservationTokens),
    );
    const truncatedObservations = working.reduce(
      (n, message, index) => (message !== messages[index] ? n + 1 : n),
      0,
    );
    let current = this.estimator.estimateMessages(working);
    if (truncatedObservations > 0) {
      actions.push({
        kind: "truncate-observation",
        truncatedObservations,
        truncatedChars: Math.max(
          0,
          messages.reduce((n, m, i) => n + (working[i] !== m ? m.content.length - (working[i]?.content.length ?? 0) : 0), 0),
        ),
      });
    }

    // Step 3: elide whole middle turns. Splitting a tool-using turn would leave
    // orphaned `tool_calls`/`tool` messages, which providers reject outright.
    if (current > effectiveBudget) {
      const head = working.slice(0, headSize);
      const turns = groupTurns(working.slice(headSize));
      // Keep the smallest *suffix* of turns (head + newest tail) that fits.
      let keptStart = turns.length;
      for (let i = turns.length - 1; i >= 0; i--) {
        const candidate = [...head, ...turns.slice(i).flatMap((t) => t.messages)];
        if (this.estimator.estimateMessages(candidate) <= effectiveBudget) {
          keptStart = i;
        } else {
          break;
        }
      }
      // Always keep at least the newest turn: dropping it would discard the
      // observation the model is about to reason over. Over budget is reported.
      if (keptStart === turns.length && turns.length > 0) keptStart = turns.length - 1;
      const tail = turns.slice(keptStart).flatMap((t) => t.messages);
      const elidedMessages = working.length - head.length - tail.length;
      if (elidedMessages > 0) {
        // Insert after the protected head, not into the system prompt: the
        // system prompt is the trust anchor (ADR 004) and is never rewritten.
        const notice: ChatMessage = {
          role: "system",
          content:
            `${elidedMessages} earlier message(s) were omitted to stay within the ` +
            `${this.budget}-token context budget. The task and the most recent ` +
            `turns are intact. Re-derive anything you still need with a tool.`,
        };
        working = [...head, notice, ...tail];
        actions.push({ kind: "elide-turns", elidedMessages, note: "oldest middle turns removed" });
        actions.push({ kind: "notice" });
      }
      current = this.estimator.estimateMessages(working);
    }

    return {
      messages: working,
      originalTokens,
      finalTokens: current,
      budget: this.budget,
      overBudget: current > effectiveBudget,
      actions,
    };
  }
}

/** Groups messages so an assistant tool-call turn stays with its results. */
function groupTurns(messages: readonly ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    current.push(message);
    // A tool-result message belongs to the assistant turn that requested it. A
    // run of tool results closes the turn; anything else is its own unit.
    if (message.role !== "tool" || !nextIsTool(messages, message)) {
      turns.push({ messages: current });
      current = [];
    }
  }
  if (current.length > 0) turns.push({ messages: current });
  return turns;
}

function nextIsTool(messages: readonly ChatMessage[], message: ChatMessage): boolean {
  const index = messages.indexOf(message);
  return index >= 0 && messages[index + 1]?.role === "tool";
}

/**
 * Shortens an oversized tool observation, keeping the head and the tail with a
 * visible marker. Both ends matter: the head usually holds the structure
 * (e.g. a compiler banner) and the tail the conclusion (e.g. the failure line).
 */
function truncateObservation(
  message: ChatMessage,
  estimator: TokenEstimator,
  maxTokens: number,
): ChatMessage {
  if (message.role !== "tool") return message;
  if (estimator.estimateMessage(message) <= maxTokens) return message;

  const maxChars = Math.max(2, maxTokens * 4);
  const half = Math.floor(maxChars / 2);
  const head = message.content.slice(0, half);
  const tail = message.content.slice(-half);
  const removed = message.content.length - head.length - tail.length;
  const content =
    `${head}\n\n[... ${removed} characters omitted to fit the context budget; ` +
    `re-read a narrower range if you need them ...]\n\n${tail}`;
  return { ...message, content };
}

export { DEFAULT_MAX_OBSERVATION_TOKENS };
