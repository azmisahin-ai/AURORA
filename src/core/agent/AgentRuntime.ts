import { loadConfig, type Config } from "../../config/Config.js";
import { createLogger, type Logger } from "../../observability/Logger.js";
import { Planner } from "../planner/Planner.js";
import { OllamaProvider } from "../../providers/llm/ollama/OllamaProvider.js";
import { OpenAICompatibleProvider } from "../../providers/llm/compatible/OpenAICompatibleProvider.js";
import type { LLMProvider } from "../../providers/llm/LLMProvider.js";
import { AgentLoop } from "./AgentLoop.js";
import type { ToolExecutor } from "./types.js";
import { buildToolRegistry } from "../../tools/index.js";

export interface RuntimeOptions {
  config?: Config;
  llm?: LLMProvider;
  tools?: ToolExecutor;
  logger?: Logger;
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
  private readonly tools: ToolExecutor;

  constructor(opts: RuntimeOptions = {}) {
    this.config = opts.config ?? loadConfig();
    this.logger = opts.logger ?? createLogger(this.config.logLevel);
    this.llm = opts.llm ?? createLLMProvider(this.config);
    this.tools = opts.tools ?? buildToolRegistry({ config: this.config, logger: this.logger });
  }

  createLoop(): AgentLoop {
    return new AgentLoop({
      llm: this.llm,
      planner: new Planner(),
      tools: this.tools,
      limits: {
        maxIterations: this.config.maxIterations,
        maxToolCalls: this.config.maxToolCalls,
        timeoutMs: this.config.timeoutMs,
      },
      logger: this.logger,
    });
  }

  async health(): Promise<boolean> {
    if (!this.llm.health) return false;
    return this.llm.health();
  }
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
