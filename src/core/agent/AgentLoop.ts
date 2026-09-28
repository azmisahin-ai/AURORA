import type { ChatMessage } from "../../providers/llm/LLMProvider.js";
import { LLMError } from "../../providers/llm/LLMProvider.js";
import type { PlanContext } from "../planner/types.js";
import { ErrorClassifier } from "../errors/ErrorClassifier.js";
import type { FailureEvidence } from "../errors/types.js";
import {
  type AgentLoopDeps,
  DEFAULT_SYSTEM_PROMPT,
  type RunOptions,
  type RunResult,
  type RunStatus,
  type TrajectoryEntry,
  type VerificationOutcome,
} from "./types.js";

/**
 * The ReAct loop: observe → reason → plan → execute → (verify) → repeat.
 *
 * Bounded by maxIterations, maxToolCalls and timeoutMs (ADR 001). Exceeding a
 * bound is a legitimate `RunStatus`, reported to the caller, never silently
 * retried.
 *
 * Verification, when supplied, must be driven by an *external* signal — the
 * model's own opinion of its work is not an acceptable verifier (ADR 001).
 */
export class AgentLoop {
  private readonly deps: AgentLoopDeps;
  private readonly classifier: ErrorClassifier;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.classifier = deps.classifier ?? new ErrorClassifier();
  }

  async run(task: string, opts: RunOptions = {}): Promise<RunResult> {
    const { llm, planner, tools, limits } = this.deps;
    const logger = this.deps.logger;

    const messages: ChatMessage[] = [
      { role: "system", content: this.deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: task },
    ];

    const trajectory: TrajectoryEntry[] = [];
    const deadline = Date.now() + limits.timeoutMs;

    // One controller governs both the caller's signal and the deadline.
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timeoutTimer = setTimeout(() => controller.abort(), limits.timeoutMs);

    let iterations = 0;
    let toolCallCount = 0;
    let output = "";
    let verificationCount = 0;
    let lastVerification: VerificationOutcome | undefined;
    let hasMutated = false;

    const maxVerifications = limits.maxVerifications ?? 0;
    const verificationEnabled = maxVerifications > 0 && this.deps.verifier !== undefined;

    const finish = (status: RunStatus, error?: string): RunResult => ({
      status,
      output,
      iterations,
      toolCalls: toolCallCount,
      trajectory,
      ...(error !== undefined ? { error } : {}),
      ...(verificationCount > 0 ? { verifications: verificationCount } : {}),
      ...(lastVerification !== undefined ? { lastVerification } : {}),
    });

    try {
      while (iterations < limits.maxIterations) {
        if (controller.signal.aborted) {
          return finish(Date.now() >= deadline ? "timeout" : "aborted");
        }
        iterations++;

        // ── reason ──────────────────────────────────────────────────────────
        let turn;
        try {
          const offeredTools = tools?.definitions?.() ?? [];
          turn = await llm.chat({
            messages,
            ...(offeredTools.length > 0 ? { tools: offeredTools } : {}),
            signal: controller.signal,
          });
        } catch (cause) {
          if (cause instanceof LLMError && controller.signal.aborted) {
            return finish(Date.now() >= deadline ? "timeout" : "aborted");
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          logger?.error({ err: message }, "llm call failed");
          return finish("error", message);
        }

        if (turn.content) output = turn.content;

        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: turn.content,
          ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
        };
        messages.push(assistantMsg);

        // ── plan ────────────────────────────────────────────────────────────
        const planCtx: PlanContext = {
          iteration: iterations,
          reasoning: turn.content,
          requestedToolCalls: turn.toolCalls.map((tc) => ({
            name: tc.name,
            arguments: tc.arguments,
          })),
        };
        const step = planner.update(planCtx);

        if (step.kind === "final") {
          // ── verify ────────────────────────────────────────────────────────
          // A model claiming completion is a hypothesis, not proof. If an
          // external verifier is present and the run changed the workspace, it
          // must agree before we accept the answer (ADR 001).
          const gate = await this.gateCompletion({
            enabled: verificationEnabled,
            hasMutated,
            verificationCount,
            maxVerifications,
            controller,
            messages,
            trajectory,
            iteration: iterations,
            assistantContent: turn.content,
          });
          if (gate.kind === "accept") {
            if (gate.verification !== undefined) {
              // Any check that actually ran counts as an attempt and is
              // recorded, so the report can distinguish "verified" from
              // "never checked" and "skipped".
              verificationCount++;
              lastVerification = gate.verification;
            }
            trajectory.push({
              iteration: iterations,
              step,
              assistantContent: turn.content,
              ...(gate.verification !== undefined
                ? { verification: gate.verification }
                : {}),
            });
            return finish("completed");
          }
          if (gate.kind === "stop") {
            trajectory.push({
              iteration: iterations,
              step,
              assistantContent: turn.content,
            });
            return finish("max_verifications", gate.error);
          }
          // gate.kind === "repair": a failing verification was appended to
          // `messages`; loop again so the model can fix the cause.
          verificationCount++;
          lastVerification = gate.verification;
          output = turn.content;
          continue;
        }

        // ── execute ─────────────────────────────────────────────────────────
        if (toolCallCount >= limits.maxToolCalls) {
          trajectory.push({
            iteration: iterations,
            step,
            assistantContent: turn.content,
          });
          return finish("max_tool_calls");
        }

        const call = turn.toolCalls.find((tc) => tc.name === step.toolName);
        if (!call) {
          // Plan pointed at a tool the model did not actually call; feed that
          // back rather than guessing.
          const observation = `Internal error: planner selected tool "${step.toolName}" but the model requested no such call.`;
          messages.push({ role: "tool", content: observation, toolName: step.toolName ?? "unknown" });
          trajectory.push({
            iteration: iterations,
            step,
            assistantContent: turn.content,
          });
          continue;
        }

        toolCallCount++;
        const result = await this.executeTool(call, tools, controller.signal);
        if (result.mutatedWorkspace === true) hasMutated = true;
        messages.push({
          role: "tool",
          content: result.observation,
          toolName: call.name,
        });
        trajectory.push({
          iteration: iterations,
          step,
          assistantContent: turn.content,
          toolCall: call,
          toolResult: result,
        });

        if (result.fatal) {
          return finish("error", result.observation);
        }
      }

      return finish("max_iterations");
    } finally {
      clearTimeout(timeoutTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Decides whether to accept a model-declared completion, or send the run back
   * to be repaired.
   *
   * The rules, in order:
   *  1. Verification disabled or no verifier  → accept (pre-Phase-4 behaviour).
   *  2. Nothing was changed this run          → accept; a verification with no
   *     edit has nothing to say about the work.
   *  3. Budget exhausted                      → stop and escalate; do not loop.
   *  4. Otherwise                             → run the verifier. Pass accepts;
   *     fail feeds a *classified* instruction back so the next iteration can
   *     actually fix the cause rather than guess.
   */
  private async gateCompletion(args: {
    enabled: boolean;
    hasMutated: boolean;
    verificationCount: number;
    maxVerifications: number;
    controller: AbortController;
    messages: ChatMessage[];
    trajectory: TrajectoryEntry[];
    iteration: number;
    assistantContent: string;
  }): Promise<
    | { kind: "accept"; verification?: VerificationOutcome }
    | { kind: "repair"; verification: VerificationOutcome }
    | { kind: "stop"; error: string }
  > {
    const { enabled, hasMutated, verificationCount, maxVerifications, controller } = args;
    const verifier = this.deps.verifier;

    if (!enabled || verifier === undefined) return { kind: "accept" };
    if (!hasMutated) {
      this.deps.logger?.debug("completion accepted: nothing changed, verification skipped");
      return { kind: "accept" };
    }

    if (controller.signal.aborted) return { kind: "accept" };

    if (verificationCount >= maxVerifications) {
      const error =
        `Verification budget exhausted after ${verificationCount} attempt(s); ` +
        `the external check "${verifier.name}" still fails. Escalating.`;
      this.deps.logger?.warn({ verifier: verifier.name }, "verification budget exhausted");
      return { kind: "stop", error };
    }

    const outcome = await verifier.verify(controller.signal);
    if (outcome.kind !== "fail") {
      // "pass" accepts; "skipped" (e.g. the tool is not permitted) must NOT be
      // reported as a pass — it accepts, but the skip is recorded in the
      // trajectory so the report can say verification did not actually run.
      return { kind: "accept", verification: outcome };
    }

    const verdict = this.classifier.classify({
      kind: "execution",
      result: outcome.evidence!,
      argv: [verifier.name],
    });

    args.messages.push({
      role: "tool",
      content:
        `EXTERNAL VERIFICATION FAILED (${verifier.name}).\n` +
        `failure class: ${verdict.category} (action: ${verdict.action})\n` +
        `${verdict.hint}\n\n${outcome.observation}`,
      toolName: "verify",
    });

    this.deps.logger?.info(
      { verifier: verifier.name, category: verdict.category, action: verdict.action },
      "completion rejected: external verification failed",
    );

    return { kind: "repair", verification: outcome };
  }

  private async executeTool(
    call: import("../../providers/llm/LLMProvider.js").ToolCall,
    tools: AgentLoopDeps["tools"],
    signal: AbortSignal,
  ) {
    if (!tools) {
      return {
        ok: false,
        observation: `Tool "${call.name}" is not available in this build.`,
      };
    }
    if (!tools.has(call.name)) {
      return {
        ok: false,
        observation: `Unknown tool "${call.name}".`,
      };
    }
    try {
      return await tools.execute(call, signal);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, observation: `Tool "${call.name}" threw: ${message}` };
    }
  }
}
