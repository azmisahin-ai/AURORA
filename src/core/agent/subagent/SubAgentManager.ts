import { AgentLoop } from "../AgentLoop.js";
import { Planner } from "../../planner/Planner.js";
import { roleDefinition } from "../roles/definitions.js";
import type {
  SubAgentManagerOptions,
  SubAgentManagerPort,
  SubAgentRequest,
  SubAgentResult,
} from "./types.js";

/**
 * Spawns role-based sub-agents inside the same process.
 *
 * Deliberately *not* a microservice (docs/research/multi-agent.md §4): the MVP
 * value is context isolation and least privilege, both of which a second
 * process would make harder to observe, not easier.
 *
 * Three guarantees, each tested:
 *  1. **Context isolation** — a sub-agent starts from its role prompt and the
 *     delegated task only. It never receives the parent's transcript.
 *  2. **Least privilege** — the toolset it gets is the intersection of its
 *     role's tool list and the parent's permissions, so it cannot escalate.
 *  3. **Bounded cost** — each role has its own iteration/tool budget, and the
 *     run has a hard `maxSubAgents` cap. Sub-agents cannot delegate.
 */
export class SubAgentManager implements SubAgentManagerPort {
  private used = 0;

  constructor(private readonly opts: SubAgentManagerOptions) {}

  remaining(): number {
    return Math.max(0, this.opts.maxSubAgents - this.used);
  }

  async run(request: SubAgentRequest, signal?: AbortSignal): Promise<SubAgentResult> {
    const { llm, toolsetBuilder, verifier, timeoutMs, logger } = this.opts;
    const definition = roleDefinition(request.role);

    if (this.remaining() <= 0) {
      return {
        role: request.role,
        status: "error",
        output: "",
        iterations: 0,
        toolCalls: 0,
        mutatedWorkspace: false,
        error:
          `Sub-agent budget exhausted (maxSubAgents=${this.opts.maxSubAgents}). ` +
          `No further delegation is possible in this run.`,
      };
    }
    this.used++;

    const { tools } = toolsetBuilder.build(request.role);

    // The verifier is passed through unconditionally; the *role's* verification
    // budget (`maxVerifications`, 0 for every current role) is what decides
    // whether the loop ever runs it. Two controls for one decision would be one
    // too many — and a branch here that the loop's own gate makes redundant is
    // a branch no test can distinguish from its absence.
    const loop = new AgentLoop({
      llm,
      planner: new Planner(),
      tools,
      ...(verifier !== undefined ? { verifier } : {}),
      systemPrompt: definition.systemPrompt,
      limits: {
        maxIterations: definition.budget.maxIterations,
        maxToolCalls: definition.budget.maxToolCalls,
        timeoutMs,
        maxVerifications: definition.budget.maxVerifications,
      },
      ...(logger !== undefined ? { logger } : {}),
    });

    logger?.info(
      { role: request.role, remaining: this.remaining() },
      "sub-agent spawned",
    );

    const result = await loop.run(request.task, signal !== undefined ? { signal } : {});

    return {
      role: request.role,
      status: result.status,
      output: result.output,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      ...(result.verifications !== undefined ? { verifications: result.verifications } : {}),
      ...(result.lastVerification !== undefined
        ? { lastVerification: result.lastVerification }
        : {}),
      mutatedWorkspace: result.mutatedWorkspace === true,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
}
