import { z } from "zod/v4";
import type { Logger } from "pino";
import type { ToolCall, ToolDefinition } from "../providers/llm/LLMProvider.js";
import type { ToolExecutor, ToolExecutionResult } from "../core/agent/types.js";
import type { PermissionManager, Permission } from "../security/PermissionManager.js";
import type { PathValidator } from "../security/PathValidator.js";
import type { CommandValidator } from "../security/CommandValidator.js";
import type { ExecutionProvider } from "../providers/execution/ExecutionProvider.js";
import type { Tool, ToolContext } from "./types.js";

export interface ToolRegistryOptions {
  permissions: PermissionManager;
  workspace: string;
  pathValidator: PathValidator;
  commandValidator: CommandValidator;
  execution: ExecutionProvider;
  logger: Logger;
}

/**
 * Holds the tools available to a run and executes them behind a permission
 * gate. Implements the loop's `ToolExecutor` port so `core` stays unaware of
 * tools.
 *
 * Invariants:
 *  - A tool whose declared permissions are not granted is never executed, and
 *    the denial is logged. The model is told the tool is unavailable, so it can
 *    adapt, but it cannot argue its way past the gate.
 *  - Arguments are validated against the tool's zod schema before execution, so
 *    a tool can trust its input.
 *  - Execution errors are converted to non-fatal observations: a misbehaving
 *    tool should not abort the run unless it says the failure is fatal.
 */
export class ToolRegistry implements ToolExecutor {
  private readonly tools = new Map<string, Tool>();
  private readonly options: ToolRegistryOptions;

  constructor(options: ToolRegistryOptions) {
    this.options = options;
  }

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Tool definitions for the LLM request, restricted to permitted tools only. */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => this.options.permissions.allows(t.requiredPermissions))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.inputSchema, { target: "draft-7" }),
      }));
  }

  /** Permissions required, but not granted, for a tool. Empty when runnable. */
  missingPermissions(name: string): Permission[] {
    const tool = this.tools.get(name);
    if (!tool) return [];
    const decision = this.options.permissions.check(tool.requiredPermissions);
    return decision.allowed ? [] : decision.missing;
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const { logger } = this.options;
    const tool = this.tools.get(call.name);
    if (!tool) {
      logger.warn({ tool: call.name }, "tool call for unknown tool rejected");
      return { ok: false, observation: `Unknown tool "${call.name}".` };
    }

    const decision = this.options.permissions.check(tool.requiredPermissions);
    if (!decision.allowed) {
      logger.warn(
        { tool: call.name, missing: decision.missing, granted: this.options.permissions.list() },
        "tool call denied: missing permissions",
      );
      return {
        ok: false,
        observation:
          `Permission denied for tool "${call.name}": missing ` +
          `${decision.missing.join(", ")}. This denial is recorded.`,
      };
    }

    const parsed = tool.inputSchema.safeParse(call.arguments);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      logger.warn({ tool: call.name, issues }, "tool arguments failed validation");
      return {
        ok: false,
        observation: `Invalid arguments for tool "${call.name}": ${issues}`,
      };
    }

    const ctx: ToolContext = {
      workspace: this.options.workspace,
      pathValidator: this.options.pathValidator,
      commandValidator: this.options.commandValidator,
      execution: this.options.execution,
      logger,
      signal: signal ?? new AbortController().signal,
    };

    const started = Date.now();
    try {
      const result = await tool.execute(parsed.data, ctx);
      logger.debug(
        { tool: call.name, ok: result.ok, ms: Date.now() - started },
        "tool executed",
      );
      return {
        ok: result.ok,
        observation: result.output,
        ...(result.fatal !== undefined ? { fatal: result.fatal } : {}),
        // On success only: a failed write changed nothing. The mutation is true
        // when the tool declared itself mutating *or* reported a change it made
        // indirectly (a delegation that edited).
        ...(result.ok && (tool.mutatesWorkspace === true || result.mutatedWorkspace === true)
          ? { mutatedWorkspace: true }
          : {}),
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error({ tool: call.name, err: message }, "tool threw");
      return { ok: false, observation: `Tool "${call.name}" failed: ${message}` };
    }
  }
}
