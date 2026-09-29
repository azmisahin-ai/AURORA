import { loadConfig, type Config } from "../../config/Config.js";
import { createLogger, type Logger } from "../../observability/Logger.js";
import { Planner } from "../planner/Planner.js";
import { OllamaProvider } from "../../providers/llm/ollama/OllamaProvider.js";
import { OpenAICompatibleProvider } from "../../providers/llm/compatible/OpenAICompatibleProvider.js";
import type { LLMProvider } from "../../providers/llm/LLMProvider.js";
import { CommandVerifier } from "../../providers/execution/CommandVerifier.js";
import { AgentLoop } from "./AgentLoop.js";
import type { RunOptions, RunResult, ToolExecutor, Verifier } from "./types.js";
import { SubAgentManager, type SubAgentManagerPort } from "./subagent/index.js";
import type { TaskExecutor } from "../task/TaskRunner.js";
import { buildToolRegistry } from "../../tools/index.js";
import { delegateTool } from "../../tools/agent/DelegateTool.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { FileSessionStore } from "../memory/SessionMemory.js";
import { buildSessionRecall } from "../memory/SessionRecall.js";
import type { SessionStore } from "../memory/types.js";
import type { ConfirmationGate } from "../../security/ConfirmationGate.js";

export interface RuntimeOptions {
  config?: Config;
  llm?: LLMProvider;
  tools?: ToolExecutor;
  verifier?: Verifier;
  logger?: Logger;
  /** Override sub-agent spawning. Tests inject a scripted manager. */
  subAgentManager?: SubAgentManagerPort;
  /** Override session persistence; defaults to `FileSessionStore`. */
  sessionStore?: SessionStore;
  /** Disable bounded context construction; used by pre-Phase-7 tests. */
  contextBuilder?: ContextBuilder | null;
  /** Confirmation gate for state-changing tools (Phase 8). */
  confirmationGate?: ConfirmationGate;
}

/**
 * Wires configuration to concrete providers and exposes the agent loop.
 *
 * Provider construction lives here (not in `core`) so that the dependency
 * direction core → providers never inverts (ADR 001, ADR 003).
 */
export class AgentRuntime {
  readonly config: Config;
  readonly llm: LLMProvider;
  readonly logger: Logger;
  readonly verifier?: Verifier;
  readonly sessions: SessionStore;
  private readonly tools: ToolExecutor;
  private readonly contextBuilder?: ContextBuilder;

  constructor(opts: RuntimeOptions = {}) {
    this.config = opts.config ?? loadConfig();
    this.logger = opts.logger ?? createLogger(this.config.logLevel);
    this.llm = opts.llm ?? createLLMProvider(this.config);
    this.sessions =
      opts.sessionStore ?? new FileSessionStore({ dir: this.config.sessionDir });
    this.contextBuilder =
      opts.contextBuilder === null
        ? undefined
        : opts.contextBuilder ??
          new ContextBuilder({ budget: this.config.tokenBudget });

    // Two steps, because the tool layer needs the manager (to register
    // `delegate`) and the manager needs the tool layer (for role toolsets).
    // Building the registry first yields the role toolset builder; the manager
    // is then constructed from it and its `delegate` tool registered back in.
    const built = buildToolRegistry({
      config: this.config,
      logger: this.logger,
      ...(opts.confirmationGate !== undefined
        ? { confirmationGate: opts.confirmationGate }
        : {}),
    });
    this.verifier = opts.verifier ?? createVerifier(this.config, built, this.logger);

    if (opts.tools) {
      this.tools = opts.tools;
    } else {
      const manager =
        opts.subAgentManager ??
        (this.config.maxSubAgents > 0
          ? new SubAgentManager({
              llm: this.llm,
              toolsetBuilder: built.roleToolsetBuilder,
              ...(this.verifier !== undefined ? { verifier: this.verifier } : {}),
              maxSubAgents: this.config.maxSubAgents,
              timeoutMs: this.config.timeoutMs,
              logger: this.logger,
            })
          : undefined);
      if (manager) built.registry.register(delegateTool(manager));
      this.tools = built.registry;
    }
  }

  createLoop(opts: { sessionRecall?: string } = {}): AgentLoop {
    return new AgentLoop({
      llm: this.llm,
      planner: new Planner(),
      tools: this.tools,
      ...(this.verifier !== undefined ? { verifier: this.verifier } : {}),
      ...(this.contextBuilder !== undefined ? { contextBuilder: this.contextBuilder } : {}),
      ...(opts.sessionRecall !== undefined ? { sessionRecall: opts.sessionRecall } : {}),
      limits: {
        maxIterations: this.config.maxIterations,
        maxToolCalls: this.config.maxToolCalls,
        timeoutMs: this.config.timeoutMs,
        maxVerifications: this.config.maxVerifications,
      },
      logger: this.logger,
    });
  }

  /**
   * Builds the untrusted-wrapped recall block from the most recent prior
   * sessions. Returns undefined when recall is disabled or nothing is stored,
   * so a first run is identical to a pre-Phase-7 run.
   */
  async recall(): Promise<string | undefined> {
    if (this.config.recallSessions <= 0) return undefined;
    const records = await this.sessions.recent(this.config.recallSessions);
    return buildSessionRecall(records);
  }

  /**
   * Runs a task and persists a session record for it. This is the composition
   * entry point; `createTaskExecutor` uses it so durable tasks also leave a
   * session trail.
   */
  async runTask(task: string, opts: RunOptions = {}): Promise<RunResult> {
    const sessionRecall = await this.recall();
    const loop = this.createLoop(sessionRecall !== undefined ? { sessionRecall } : {});
    const result = await loop.run(task, opts);
    await this.saveSession(task, result);
    return result;
  }

  private async saveSession(task: string, result: RunResult): Promise<void> {
    try {
      await this.sessions.save(
        FileSessionStore.toRecord({
          task,
          status: result.status,
          output: result.output,
          toolsUsed: uniqueToolNames(result.trajectory),
          iterations: result.iterations,
          toolCalls: result.toolCalls,
        }),
      );
    } catch (error) {
      // Session persistence must never fail a run that otherwise succeeded.
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to persist session record",
      );
    }
  }

  /**
   * Adapts the agent loop to the `TaskExecutor` port so `core/task` can drive
   * persisted work without importing providers (ADR 001). Each task gets a
   * fresh loop, so no context leaks between tasks.
   */
  createTaskExecutor(): TaskExecutor {
    return {
      execute: async (task, signal) => {
        const result = await this.runTask(
          task.prompt,
          signal !== undefined ? { signal } : {},
        );
        return {
          status: result.status,
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
      },
    };
  }

  async health(): Promise<boolean> {
    if (!this.llm.health) return false;
    return this.llm.health();
  }
}

/**
 * Builds the external verifier only when a test command is configured *and*
 * verification is enabled. Returns undefined otherwise, so a run with no
 * verification behaves exactly as before Phase 4.
 */
function createVerifier(
  config: Config,
  built: ReturnType<typeof buildToolRegistry>,
  logger: Logger,
): Verifier | undefined {
  if (config.testCommand.trim() === "" || config.maxVerifications <= 0) return undefined;
  return new CommandVerifier({
    command: config.testCommand,
    execution: built.execution,
    commandValidator: built.commandValidator,
    permissions: built.permissions,
    cwd: built.workspace,
    timeoutMs: config.testTimeoutMs,
    logger,
  });
}

/** Tool names in first-use order, deduplicated, for the session record. */
function uniqueToolNames(trajectory: readonly { toolCall?: { name: string } }[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of trajectory) {
    const name = entry.toolCall?.name;
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function createLLMProvider(config: Config): LLMProvider {
  switch (config.llmProvider) {
    case "ollama":
      return new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        baseUrl: config.openAICompatibleBaseUrl,
        apiKey: config.openAICompatibleApiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
    default: {
      const exhaustive: never = config.llmProvider;
      throw new Error(`Unsupported LLM provider: ${String(exhaustive)}`);
    }
  }
}
