import type { PlanContext, PlanStep } from "./types.js";

/**
 * Turns a model turn into the next concrete step.
 *
 * MVP behaviour is deliberately thin: if the model requested tool calls, the
 * first one becomes the next step. If the model produced text and no tool call,
 * the loop is done. A richer planner (multi-step decomposition, verification
 * scheduling) belongs in Phase 4+, behind this same interface.
 */
export class Planner {
  update(ctx: PlanContext): PlanStep {
    const first = ctx.requestedToolCalls[0];
    if (first) {
      return {
        kind: "tool",
        rationale: `Model requested tool "${first.name}"`,
        toolName: first.name,
        toolArguments: first.arguments,
      };
    }
    return {
      kind: "final",
      rationale: "Model produced a final answer with no tool call",
    };
  }
}
