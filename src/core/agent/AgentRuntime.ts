import { loadConfig, type Config } from "../../config/Config.js";
import { createLogger, type Logger } from "../../observability/Logger.js";
import { Planner } from "../planner/Planner.js";
import { OllamaProvider } from "../../providers/llm/ollama/OllamaProvider.js";
import { OpenAICompatibleProvider } from "../../providers/llm/compatible/OpenAICompatibleProvider.js";
import type { LLMProvider } from "../../providers/llm/LLMProvider.js";
import { CommandVerifier } from "../../providers/execution/CommandVerifier.js";
import { AgentLoop } from "./AgentLoop.js";
import type { ToolExecutor, Verifier } from "./types.js";
import { SubAgentManager, type SubAgentManagerPort } from "./subagent/index.js";
import { buildToolRegistry } from "../../tools/index.js";
import { delegateTool } from "../../tools/agent/DelegateTool.js";

export interface RuntimeOptions {
  config?: Config;
  llm?: LLMProvider;
  tools?: ToolExecutor;
  verifier?: Verifier;
  logger?: Logger;
  /** Override sub-agent spawning. Tests inject a scripted manager. */
  subAgentManager?: SubAgentManagerPort;
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
  private readonly tools: ToolExecutor;

  constructor(opts: RuntimeOptions = {}) {
    this.config = opts.config ?? loadConfig();
    this.logger = opts.logger ?? createLogger(this.config.logLevel);
    this.llm = opts.llm ?? createLLMProvider(this.config);

    // Two steps, because the tool layer needs the manager (to register
    // `delegate`) and the manager needs the tool layer (for role toolsets).
    // Building the registry first yields the role toolset builder; the manager
    // is then constructed from it and its `delegate` tool registered back in.
    const built = buildToolRegistry({
      config: this.config,
      logger: this.logger,
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

  createLoop(): AgentLoop {
    return new AgentLoop({
      llm: this.llm,
      planner: new Planner(),
      tools: this.tools,
      ...(this.verifier !== undefined ? { verifier: this.verifier } : {}),
      limits: {
        maxIterations: this.config.maxIterations,
        maxToolCalls: this.config.maxToolCalls,
        timeoutMs: this.config.timeoutMs,
        maxVerifications: this.config.maxVerifications,
      },
      logger: this.logger,
    });
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
