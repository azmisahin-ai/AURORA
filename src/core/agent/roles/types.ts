import type { Permission } from "../../../security/PermissionManager.js";

/** The roles a sub-agent can take. Fixed set: a role is a curated prompt + tool
 * set, not an arbitrary string, so an orchestrating model cannot invent one. */
export type AgentRole = "researcher" | "coder" | "tester" | "reviewer" | "documenter";

export const AGENT_ROLES: readonly AgentRole[] = [
  "researcher",
  "coder",
  "tester",
  "reviewer",
  "documenter",
];

export interface RoleBudget {
  /** Cap on the sub-agent's own ReAct iterations for one delegation. */
  maxIterations: number;
  /** Cap on the sub-agent's tool calls for one delegation. */
  maxToolCalls: number;
  /**
   * Cap on the sub-agent's *external* verification attempts (ADR 006). Only
   * roles whose work is judged by an external signal set this above 0.
   */
  maxVerifications: number;
}

export interface RoleDefinition {
  readonly role: AgentRole;
  /** One line, shown to the orchestrating model in the `delegate` description. */
  readonly summary: string;
  /**
   * The sub-agent's system prompt. It *replaces* the parent's rather than
   * extending it: a sub-agent is not the parent, and inheriting the parent's
   * framing is what makes multi-agent systems blur into one large context.
   */
  readonly systemPrompt: string;
  /**
   * Tools this role may use, by name. Intersected with what the parent is
   * permitted to do, so a role can never *escalate* beyond its parent.
   * `delegate` is deliberately absent from every role: sub-agents cannot
   * delegate further (no unbounded recursion).
   */
  readonly tools: readonly string[];
  /** Permissions the role must never exceed, even if the parent holds them. */
  readonly maxPermissions: readonly Permission[];
  readonly budget: RoleBudget;
}
