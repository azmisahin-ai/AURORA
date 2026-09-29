import { z } from "zod/v4";
import type { Logger } from "pino";
import type { ToolCall, ToolDefinition } from "../providers/llm/LLMProvider.js";
import type { ToolExecutor, ToolExecutionResult } from "../core/agent/types.js";
import type { PermissionManager, Permission } from "../security/PermissionManager.js";
import type { PathValidator } from "../security/PathValidator.js";
import type { CommandValidator } from "../security/CommandValidator.js";
import type { ExecutionProvider } from "../providers/execution/ExecutionProvider.js";
import type { ConfirmationGate } from "../security/ConfirmationGate.js";
import { AllowAllGate } from "../security/ConfirmationGate.js";
import type { KeyedRateLimiter } from "../security/RateLimiter.js";
import { SecretRedactor } from "../security/SecretRedactor.js";
import { coerceArguments } from "./coerce.js";
import type { Tool, ToolContext } from "./types.js";
import { NULL_EVENT_BUS, type EventEmitterPort } from "../events/index.js";

export interface ToolRegistryOptions {
  permissions: PermissionManager;
  workspace: string;
  pathValidator: PathValidator;
  commandValidator: CommandValidator;
  execution: ExecutionProvider;
  logger: Logger;
  /**
   * Event sink for capability visibility (M0, CAP-004). Defaults to a no-op, so
   * a registry without a bus behaves exactly as it did before events existed.
   */
  events?: EventEmitterPort;
  /** Correlates emitted events. Empty when the registry is not run-scoped. */
  runId?: string;
  taskId?: string;
  /**
   * Asked before a state-changing tool runs (Phase 8). Defaults to
   * `AllowAllGate`: an unattended run should not deadlock on a prompt, and the
   * controls that actually constrain it are permissions and validators.
   */
  confirmationGate?: ConfirmationGate;
  /** Per-tool token buckets, applied to tools that reach the network. */
  rateLimiter?: KeyedRateLimiter;
  /** Hard cap on serialised tool arguments. Defaults to 64 KiB. */
  maxArgumentBytes?: number;
  /**
   * Fields scrubbed from *log* events. Arguments are redacted before they are
   * logged; the model still receives the raw observation (ADR 010).
   */
  redactor?: SecretRedactor;
}

const DEFAULT_MAX_ARGUMENT_BYTES = 64 * 1024;

/** Tools whose success can change state, and so are confirmation-gated. */
function requiresConfirmation(tool: Tool): boolean {
  return tool.mutatesWorkspace === true || tool.requiredPermissions.includes("COMMAND_EXECUTION");
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
  /** Generated JSON Schema per tool, computed once — it is immutable. */
  private readonly schemaCache = new WeakMap<Tool, unknown>();

  constructor(options: ToolRegistryOptions) {
    this.options = options;
  }

  private jsonSchema(tool: Tool): unknown {
    let schema = this.schemaCache.get(tool);
    if (schema === undefined) {
      schema = z.toJSONSchema(tool.inputSchema, { target: "draft-7" });
      this.schemaCache.set(tool, schema);
    }
    return schema;
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
        parameters: this.jsonSchema(t),
      }));
  }

  /** Permissions required, but not granted, for a tool. Empty when runnable. */
  missingPermissions(name: string): Permission[] {
    const tool = this.tools.get(name);
    if (!tool) return [];
    const decision = this.options.permissions.check(tool.requiredPermissions);
    return decision.allowed ? [] : decision.missing;
  }

  async execute(
    call: ToolCall,
    signal?: AbortSignal,
    scope?: import("../core/agent/types.js").ToolExecutionScope,
  ): Promise<ToolExecutionResult> {
    const { logger } = this.options;
    const emit = (
      type: string,
      payload: unknown,
      origin: string,
    ): void => {
      const bus = scope?.events ?? this.options.events ?? NULL_EVENT_BUS;
      bus.emit({
        type,
        source: origin,
        runId: scope?.runId ?? this.options.runId ?? "",
        taskId: scope?.taskId ?? this.options.taskId ?? "",
        payload,
      });
    };
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
      emit(
        "tool.failed",
        { tool: call.name, reason: "permission_denied", missing: decision.missing },
        "tool-registry",
      );
      return {
        ok: false,
        observation:
          `Permission denied for tool "${call.name}": missing ` +
          `${decision.missing.join(", ")}. This denial is recorded.`,
      };
    }

    // Normalise the model's argument types against the tool's own schema before
    // validating. Models routinely send `"5"` for an integer and `"true"` for a
    // boolean; rejecting those burns an iteration for no reason and tells the
    // model nothing useful. Coercion is schema-driven, so a string field is
    // never turned into a number (see `coerce.ts`).
    const coerced = coerceArguments(call.arguments, this.jsonSchema(tool));
    const parsed = tool.inputSchema.safeParse(coerced);
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

    // Bound the arguments before anything else touches them. A model that
    // pastes a whole file into a tool call is a context-flooding attempt, and
    // the cap is cheaper to enforce at the door than in each tool.
    const maxArgumentBytes = this.options.maxArgumentBytes ?? DEFAULT_MAX_ARGUMENT_BYTES;
    const argumentBytes = Buffer.byteLength(JSON.stringify(call.arguments ?? {}), "utf8");
    if (argumentBytes > maxArgumentBytes) {
      logger.warn(
        { tool: call.name, argumentBytes, limit: maxArgumentBytes },
        "tool arguments exceeded the size cap",
      );
      return {
        ok: false,
        observation:
          `Argument payload for tool "${call.name}" is ${argumentBytes} bytes; ` +
          `the limit is ${maxArgumentBytes}.`,
      };
    }

    // Rate-limit tools that reach the network. The point is to stop a loop, not
    // a user: the observation tells the model to slow down, and the wait is
    // bounded so one denial cannot stall the run forever.
    if (this.options.rateLimiter && tool.requiredPermissions.includes("NETWORK_ACCESS")) {
      const decision = this.options.rateLimiter.tryAcquire(call.name);
      if (!decision.allowed) {
        logger.warn({ tool: call.name, retryAfterMs: decision.retryAfterMs }, "tool call rate-limited");
        return {
          ok: false,
          observation:
            `Rate limit reached for tool "${call.name}". ` +
            `Retry in about ${decision.retryAfterMs} ms, or continue without it.`,
        };
      }
    }

    // Confirmation gate for state-changing calls. The three outcomes are kept
    // distinct; only an explicit denial stops the call. Emission makes the
    // approval visible in the UI rather than an invisible internal decision.
    const gate = this.options.confirmationGate;
    if (gate !== undefined && requiresConfirmation(tool)) {
      // Summarise the *redacted* arguments, so a summary can never leak a
      // credential the arguments themselves were scrubbed of.
      const safeArgs = this.options.redactor
        ? this.options.redactor.redactValue(parsed.data)
        : parsed.data;
      const summary = summarizeCall(tool, safeArgs);
      emit(
        "approval.requested",
        { tool: call.name, gate: gate.name, summary, arguments: safeArgs },
        "tool-registry",
      );
      const outcome = await gate.request({
        tool: call.name,
        summary,
        arguments: safeArgs,
      });
      if (outcome === "denied") {
        logger.warn({ tool: call.name, args: safeArgs, gate: gate.name }, "tool call denied by confirmation gate");
        emit(
          "approval.denied",
          { tool: call.name, gate: gate.name, summary, arguments: safeArgs },
          "tool-registry",
        );
        return {
          ok: false,
          observation: `User denied permission to run "${call.name}". This denial is recorded.`,
          denied: true,
        };
      }
      if (outcome === "unavailable") {
        logger.info({ tool: call.name, gate: gate.name }, "confirmation unavailable; proceeding under policy");
        emit(
          "approval.unavailable",
          { tool: call.name, gate: gate.name, summary },
          "tool-registry",
        );
      } else {
        emit(
          "approval.approved",
          { tool: call.name, gate: gate.name, summary, arguments: safeArgs },
          "tool-registry",
        );
      }
    }

    emit(
      "tool.requested",
      { tool: call.name, arguments: parsed.data },
      "tool-registry",
    );

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
      const ms = Date.now() - started;
      logger.debug(
        { tool: call.name, ok: result.ok, ms },
        "tool executed",
      );
      emit(
        result.ok ? "tool.completed" : "tool.failed",
        {
          tool: call.name,
          ok: result.ok,
          ms,
          ...(result.ok ? {} : { observation: truncate(result.output, 500) }),
        },
        "tool-registry",
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
      emit(
        "tool.failed",
        { tool: call.name, reason: "threw", error: message },
        "tool-registry",
      );
      return { ok: false, observation: `Tool "${call.name}" failed: ${message}` };
    }
  }
}

/** Bound an observation string before it goes into an event payload. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A one-line summary of a call for the confirmation prompt. Deliberately terse
 * and derived from the schema, so it names the action without leaking a whole
 * argument payload into a terminal the user may be screen-sharing.
 */
function summarizeCall(tool: Tool, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  for (const key of ["path", "command", "url", "role"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      bits.push(`${key}=${value.length > 80 ? `${value.slice(0, 77)}...` : value}`);
    }
  }
  return bits.length > 0 ? bits.join(" ") : tool.description.split(".")[0]!.slice(0, 100);
}
