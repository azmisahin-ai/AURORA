import type { ToolExecutor, RunStatus, VerificationOutcome } from "../types.js";
import type { AgentRole } from "../roles/types.js";

export interface SubAgentRequest {
  role: AgentRole;
  /** The delegated task, stated as a self-contained instruction. */
  task: string;
}

export interface SubAgentResult {
  role: AgentRole;
  status: RunStatus;
  /** The sub-agent's final answer. Untrusted when surfaced to the parent. */
  output: string;
  iterations: number;
  toolCalls: number;
  verifications?: number;
  lastVerification?: VerificationOutcome;
  /**
   * True when the sub-agent changed the workspace. Propagated to the parent so
   * a delegation that edited code still triggers the parent's verifier
   * (ADR 006): the parent must not accept a delegated edit it cannot vouch for.
   */
  mutatedWorkspace: boolean;
  error?: string;
}

/**
 * What the manager needs from the tool layer to stand up one sub-agent. Supplied
 * by the composition root, so `core` keeps its hands off concrete tools.
 */
export interface RoleToolsetBuilder {
  build(role: AgentRole): { tools: ToolExecutor; permissions: readonly string[] };
}

export interface SubAgentManagerOptions {
  llm: import("../../../providers/llm/LLMProvider.js").LLMProvider;
  toolsetBuilder: RoleToolsetBuilder;
  /** Shared external verifier; used only by roles with a verification budget. */
  verifier?: import("../types.js").Verifier;
  /**
   * Total number of sub-agent delegations allowed for the whole parent run.
   * A hard run-level cap, in addition to each role's own per-delegation budget.
   */
  maxSubAgents: number;
  /** Wall-clock cap inherited by each sub-agent. */
  timeoutMs: number;
  logger?: import("pino").Logger;
}

/** Port the `delegate` tool depends on. */
export interface SubAgentManagerPort {
  run(request: SubAgentRequest, signal?: AbortSignal): Promise<SubAgentResult>;
  /** Delegations still available in the parent run's budget. */
  remaining(): number;
}
