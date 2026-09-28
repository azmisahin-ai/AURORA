import type { ChatMessage } from "../../providers/llm/LLMProvider.js";
import { LLMError } from "../../providers/llm/LLMProvider.js";
import type { PlanContext } from "../planner/types.js";
import {
  type AgentLoopDeps,
  DEFAULT_SYSTEM_PROMPT,
  type RunOptions,
  type RunResult,
  type RunStatus,
  type TrajectoryEntry,
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

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
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

    const finish = (status: RunStatus, error?: string): RunResult => ({
      status,
      output,
      iterations,
      toolCalls: toolCallCount,
      trajectory,
      ...(error !== undefined ? { error } : {}),
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
          turn = await llm.chat({ messages, signal: controller.signal });
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
          trajectory.push({
            iteration: iterations,
            step,
            assistantContent: turn.content,
          });
          return finish("completed");
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
