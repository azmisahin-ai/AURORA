import { z } from "zod/v4";
import { defineTool } from "../types.js";
import { AGENT_ROLES, ROLE_DEFINITIONS } from "../../core/agent/roles/index.js";
import type { SubAgentManagerPort } from "../../core/agent/subagent/index.js";
import { wrapUntrusted } from "../../security/UntrustedData.js";

/**
 * Delegates a self-contained task to a role-based sub-agent (Phase 5).
 *
 * This tool is the only way the model can spend sub-agent budget, so the
 * delegation is visible in the trajectory like any other action rather than
 * happening invisibly behind the loop.
 *
 * Two things it deliberately does **not** declare:
 *  - It is not `mutatesWorkspace`. Whether the workspace changes is decided by
 *    what the sub-agent does, which is not known until it runs. The tool
 *    reports that dynamically instead, so a delegation that edited code still
 *    triggers the parent's verifier (ADR 006).
 *  - It is not offered to sub-agents: no role lists it, and it is registered
 *    into the parent registry outside the catalog the role registries draw
 *    from. Sub-agents therefore cannot delegate, and recursion is bounded by
 *    construction rather than by a runtime depth check.
 *
 * The sub-agent's answer is wrapped as untrusted data. It is our own model's
 * output, but a researcher's answer routinely quotes fetched pages, so it sits
 * on the same side of the trust boundary as the content it summarises.
 */
export function delegateTool(manager: SubAgentManagerPort) {
  const roleList = AGENT_ROLES.map((r) => `"${r}" — ${ROLE_DEFINITIONS[r].summary}`).join("; ");

  return defineTool({
    name: "delegate",
    description:
      "Delegate a self-contained task to a specialised sub-agent and get its result. " +
      `Roles: ${roleList}. ` +
      "The sub-agent works in an isolated context with its own budget and a restricted " +
      "tool set; it cannot see this conversation. State the task fully and self-contained. " +
      "Delegation is limited, so use it when a role genuinely fits.",
    inputSchema: z.object({
      role: z.enum(AGENT_ROLES as unknown as [string, ...string[]]).describe("Which sub-agent role to use"),
      task: z
        .string()
        .min(1)
        .describe("A complete, self-contained instruction — the sub-agent cannot see this conversation"),
    }),
    // Delegation itself touches nothing; the sub-agent's tools are permission-
    // checked in their own registry, intersected with what this run already has.
    requiredPermissions: [] as const,
    async execute(input, ctx) {
      const role = input.role as (typeof AGENT_ROLES)[number];
      const result = await manager.run({ role, task: input.task }, ctx.signal);

      const header = [
        `sub-agent: ${result.role}`,
        `status: ${result.status}`,
        `iterations: ${result.iterations}`,
        `tool calls: ${result.toolCalls}`,
        ...(result.verifications !== undefined ? [`verifications: ${result.verifications}`] : []),
        `remaining delegations: ${manager.remaining()}`,
        ...(result.error !== undefined ? [`error: ${result.error}`] : []),
      ].join("\n");

      const wrapped = wrapUntrusted(result.output || "(no output)", {
        origin: `delegate:${result.role}`,
      });

      // A sub-agent that changed the workspace did so on the parent's behalf;
      // report it so the parent's verifier is not skipped for a delegated edit.
      const mutated = result.mutatedWorkspace;

      return {
        ok: result.status === "completed",
        output: `${header}\n\n${wrapped.text}`,
        ...(mutated ? { mutatedWorkspace: true } : {}),
      };
    },
  });
}
