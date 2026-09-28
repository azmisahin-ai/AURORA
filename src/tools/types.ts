import type { z } from "zod/v4";
import type { Logger } from "pino";
import type { Permission } from "../security/PermissionManager.js";
import type { PathValidator } from "../security/PathValidator.js";
import type { CommandValidator } from "../security/CommandValidator.js";
import type { ExecutionProvider } from "../providers/execution/ExecutionProvider.js";

/**
 * Runtime services a tool may use. The registry constructs one per execution
 * request; tools never reach for globals.
 */
export interface ToolContext {
  /** Absolute root tools may read/write; also the default cwd. */
  workspace: string;
  pathValidator: PathValidator;
  commandValidator: CommandValidator;
  execution: ExecutionProvider;
  logger: Logger;
  signal: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model as the observation. */
  output: string;
  /** True when the failure must stop the run rather than be fed back. */
  fatal?: boolean;
  /**
   * Set by a tool that changed the workspace *indirectly* (e.g. `delegate` ran
   * a sub-agent that edited). The registry ORs this with the tool's static
   * `mutatesWorkspace` declaration, on success only.
   */
  mutatedWorkspace?: boolean;
}

/**
 * A tool. `inputSchema` is a zod schema — the single source of truth: the
 * registry derives the JSON Schema offered to the model from it *and* uses it
 * to validate the model's arguments before execution.
 */
export interface Tool<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly requiredPermissions: readonly Permission[];
  /**
   * True when a successful call can change the *workspace* (the code under
   * development). The loop only invokes an external verifier after such a call,
   * so pure research is never subjected to a code test (ADR 006).
   *
   * Deliberately narrow: knowledge writes and `run_command` do not set this.
   * A knowledge entry is not code, and `run_command` is ambiguous — it is the
   * very tool a test verifier executes, so treating it as a mutation would make
   * verification trigger itself.
   */
  readonly mutatesWorkspace?: boolean;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** Helper preserving inference when defining a tool. */
export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
