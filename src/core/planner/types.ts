export type StepKind = "reason" | "tool" | "verify" | "final";

export interface PlanStep {
  kind: StepKind;
  /** Human-readable rationale, for logs and trajectories. */
  rationale: string;
  /** Present when kind === "tool". */
  toolName?: string;
  toolArguments?: Record<string, unknown>;
}

export interface PlanContext {
  iteration: number;
  /** Last assistant message content. */
  reasoning: string;
  /** Tool calls the model requested this turn. */
  requestedToolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
}
