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
import { NULL_EVENT_BUS } from "../../events/index.js";

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
    const runId = opts.runId ?? this.deps.runId ?? "";
    const taskId = opts.taskId ?? this.deps.taskId ?? "";

    const messages: ChatMessage[] = [
      { role: "system", content: this.deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      // Prior-session recall, when present, is a *user* message: it is data
      // (ADR 004). It precedes the task so the task remains the last word.
      ...(this.deps.sessionRecall
        ? [{ role: "user" as const, content: this.deps.sessionRecall }]
        : []),
      { role: "user", content: task },
    ];

    const trajectory: TrajectoryEntry[] = [];

    // One controller governs both the caller's signal and the deadline. The
    // timeout is recorded in a flag rather than re-derived by comparing wall
    // clocks: `setTimeout` can fire a hair before `Date.now()` reaches the
    // deadline, which would misreport a genuine timeout as an external abort.
    let timedOut = false;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.timeoutMs);

    let iterations = 0;
    let toolCallCount = 0;
    let output = "";
    let verificationCount = 0;
    let lastVerification: VerificationOutcome | undefined;
    let hasMutated = false;
    let deniedCall = false;
    let deniedObservation = "";
    let compactions = 0;
    let lastPlan: import("../context/types.js").ContextPlan | undefined;

    const maxVerifications = limits.maxVerifications ?? 0;
    const verificationEnabled = maxVerifications > 0 && this.deps.verifier !== undefined;

    // Resolve the event sink once. `runId`/`taskId` default to identifiers the
    // caller supplied; a CLI run with neither still emits, so the trajectory is
    // observable even without a correlation id.
    const bus = this.deps.events ?? NULL_EVENT_BUS;
    const emit = (type: string, payload: unknown): void => {
      bus.emit({ type, payload, source: "agent-loop", runId, taskId });
    };
    emit("agent.started", { task, maxIterations: limits.maxIterations, maxToolCalls: limits.maxToolCalls });

    // The full transcript lives in `messages`; each provider call gets a
    // budget-bounded view (ADR 009). No builder → the view is the transcript,
    // which preserves the pre-Phase-7 behaviour exactly.
    const view = (): ChatMessage[] => {
      if (!this.deps.contextBuilder) return messages;
      const plan = this.deps.contextBuilder.build(messages);
      lastPlan = plan;
      if (plan.actions.some((a) => a.kind === "elide-turns" || a.kind === "truncate-observation")) {
        compactions++;
        logger?.debug(
          { originalTokens: plan.originalTokens, finalTokens: plan.finalTokens, budget: plan.budget },
          "context compacted",
        );
      }
      if (plan.overBudget) {
        logger?.warn(
          { finalTokens: plan.finalTokens, budget: plan.budget },
          "context still over budget after compaction",
        );
      }
      return plan.messages;
    };

    const finish = (status: RunStatus, error?: string): RunResult => ({
      status,
      output,
      iterations,
      toolCalls: toolCallCount,
      trajectory,
      ...(error !== undefined ? { error } : {}),
      ...(verificationCount > 0 ? { verifications: verificationCount } : {}),
      ...(lastVerification !== undefined ? { lastVerification } : {}),
      ...(hasMutated ? { mutatedWorkspace: true } : {}),
      context: {
        compactions,
        ...(lastPlan ? { finalTokens: lastPlan.finalTokens, overBudget: lastPlan.overBudget } : {}),
      },
    });

    /** `finish` plus the terminal agent event, so callers cannot forget it. */
    const finishAndEmit = (status: RunStatus, error?: string): RunResult => {
      const result = finish(status, error);
      // Only a genuine completion is `completed`. A budget exhaustion, timeout
      // or external abort did not achieve the task, and reporting it as
      // `agent.completed` would be the same NOT_VERIFIED-as-COMPLETED mistake in
      // a different place.
      emit(status === "completed" ? "agent.completed" : "agent.failed", {
        status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        ...(error !== undefined ? { error } : {}),
        ...(result.verifications !== undefined ? { verifications: result.verifications } : {}),
      });
      return result;
    };

    try {
      while (iterations < limits.maxIterations) {
        if (controller.signal.aborted) {
          return finishAndEmit(timedOut ? "timeout" : "aborted");
        }
        iterations++;

        // ── reason ──────────────────────────────────────────────────────────
        let turn;
        try {
          const offeredTools = tools?.definitions?.() ?? [];
          emit("model.requested", {
            model: this.deps.modelName ?? "unknown",
            tools: offeredTools.map((t) => t.name),
            messageCount: messages.length,
          });
          turn = await llm.chat({
            messages: view(),
            ...(offeredTools.length > 0 ? { tools: offeredTools } : {}),
            signal: controller.signal,
          });
          emit("model.response", {
            toolCalls: turn.toolCalls.map((tc) => tc.name),
            contentChars: turn.content?.length ?? 0,
            ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
          });
        } catch (cause) {
          if (cause instanceof LLMError && controller.signal.aborted) {
            return finishAndEmit(timedOut ? "timeout" : "aborted");
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          logger?.error({ err: message }, "llm call failed");
          emit("model.failed", { error: message });
          return finishAndEmit("error", message);
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
            // A run whose required mutation was refused is not a completed run.
            // The model said it was done, but the change it depended on never
            // happened (ADR 010). Report the denial honestly instead of the
            // NOT_VERIFIED-as-COMPLETED mistake the gate exists to prevent.
            if (deniedCall) {
              return finishAndEmit(
                "denied",
                deniedObservation ||
                  "A required workspace change was refused by the confirmation gate.",
              );
            }
            return finishAndEmit("completed");
          }
          if (gate.kind === "stop") {
            trajectory.push({
              iteration: iterations,
              step,
              assistantContent: turn.content,
            });
            return finishAndEmit("max_verifications", gate.error);
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
          return finishAndEmit("max_tool_calls");
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
        const result = await this.executeTool(call, tools, controller.signal, runId, taskId);
        if (result.mutatedWorkspace === true) {
          hasMutated = true;
          // A later approved mutation supersedes an earlier denial: the run did
          // change the workspace, so it is no longer a denied run.
          deniedCall = false;
          emit("file.modified", { tool: call.name });
        }
        if (result.denied === true) {
          // A state-changing call was refused by the confirmation gate. Record
          // the latest denial text; whether it makes the run "denied" is decided
          // at completion, because a later approved mutation can recover it.
          deniedCall = true;
          deniedObservation = result.observation;
        }
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
          return finishAndEmit("error", result.observation);
        }
      }

      return finishAndEmit("max_iterations");
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
      this.deps.events?.emit({
        type: "verification.skipped",
        source: "agent-loop",
        runId: this.deps.runId ?? "",
        taskId: this.deps.taskId ?? "",
        payload: { reason: "nothing_changed" },
      });
      return { kind: "accept" };
    }

    if (controller.signal.aborted) return { kind: "accept" };

    if (verificationCount >= maxVerifications) {
      const error =
        `Verification budget exhausted after ${verificationCount} attempt(s); ` +
        `the external check "${verifier.name}" still fails. Escalating.`;
      this.deps.logger?.warn({ verifier: verifier.name }, "verification budget exhausted");
      this.deps.events?.emit({
        type: "verification.failed",
        source: "agent-loop",
        runId: this.deps.runId ?? "",
        taskId: this.deps.taskId ?? "",
        payload: { verifier: verifier.name, reason: "budget_exhausted", attempts: verificationCount },
      });
      return { kind: "stop", error };
    }

    this.deps.events?.emit({
      type: "verification.started",
      source: "agent-loop",
      runId: this.deps.runId ?? "",
      taskId: this.deps.taskId ?? "",
      payload: { verifier: verifier.name, attempt: verificationCount + 1 },
    });

    const outcome = await verifier.verify(controller.signal);
    if (outcome.kind !== "fail") {
      // "pass" accepts; "skipped" (e.g. the tool is not permitted) must NOT be
      // reported as a pass — it accepts, but the skip is recorded in the
      // trajectory so the report can say verification did not actually run.
      this.deps.events?.emit({
        type: outcome.kind === "pass" ? "verification.passed" : "verification.skipped",
        source: "agent-loop",
        runId: this.deps.runId ?? "",
        taskId: this.deps.taskId ?? "",
        payload: { verifier: verifier.name, observation: outcome.observation },
      });
      if (outcome.kind === "pass" && verificationCount > 0) {
        // A pass after at least one recorded failure means a repair round-trip
        // actually closed. Emitting it separately lets the timeline show
        // "repair.completed" rather than only the two verification events.
        this.deps.events?.emit({
          type: "repair.completed",
          source: "agent-loop",
          runId: this.deps.runId ?? "",
          taskId: this.deps.taskId ?? "",
          payload: { verifier: verifier.name, attempts: verificationCount + 1 },
        });
      }
      return { kind: "accept", verification: outcome };
    }

    this.deps.events?.emit({
      type: "verification.failed",
      source: "agent-loop",
      runId: this.deps.runId ?? "",
      taskId: this.deps.taskId ?? "",
      payload: {
        verifier: verifier.name,
        attempt: verificationCount + 1,
        observation: outcome.observation.slice(0, 500),
      },
    });

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
    runId: string,
    taskId: string,
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
      // Pass the event scope so a per-run bus reaches the registry even when the
      // registry itself was constructed once and shared.
      return await tools.execute(call, signal, {
        ...(this.deps.events !== undefined ? { events: this.deps.events } : {}),
        runId,
        taskId,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, observation: `Tool "${call.name}" threw: ${message}` };
    }
  }
}
