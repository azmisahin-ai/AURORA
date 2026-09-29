import type { Command } from "commander";
import { loadConfig } from "../../config/Config.js";
import { createLogger } from "../../observability/Logger.js";
import { AgentRuntime } from "../../core/agent/AgentRuntime.js";

export interface RunCommandOptions {
  maxIterations?: string;
  model?: string;
  provider?: string;
  testCommand?: string;
  maxVerifications?: string;
  maxSubAgents?: string;
  recallSessions?: string;
  noRecall?: boolean;
  contextBudget?: string;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a task through the agent loop")
    .argument("<task>", "the task for the agent")
    .option("--max-iterations <n>", "override AURORA_MAX_ITERATIONS")
    .option("--model <name>", "override AURORA_MODEL")
    .option("--provider <name>", "override AURORA_LLM_PROVIDER (ollama|openai-compatible)")
    .option("--test-command <cmd>", "external check run before accepting completion (Phase 4)")
    .option("--max-verifications <n>", "cap on verify→repair attempts; 0 disables")
    .option("--max-sub-agents <n>", "cap on sub-agent delegations; 0 disables (Phase 5)")
    .option("--recall-sessions <n>", "prior sessions summarised into context; 0 disables (Phase 7)")
    .option("--no-recall", "disable prior-session recall for this run (Phase 7)")
    .option("--context-budget <tokens>", "override AURORA_TOKEN_BUDGET (Phase 7)")
    .action(async (task: string, options: RunCommandOptions) => {
      const env = { ...process.env };
      if (options.maxIterations) env.AURORA_MAX_ITERATIONS = options.maxIterations;
      if (options.model) env.AURORA_MODEL = options.model;
      if (options.provider) env.AURORA_LLM_PROVIDER = options.provider;
      if (options.testCommand) env.AURORA_TEST_COMMAND = options.testCommand;
      if (options.maxVerifications) env.AURORA_MAX_VERIFICATIONS = options.maxVerifications;
      if (options.maxSubAgents) env.AURORA_MAX_SUB_AGENTS = options.maxSubAgents;
      if (options.recallSessions) env.AURORA_RECALL_SESSIONS = options.recallSessions;
      if (options.noRecall) env.AURORA_RECALL_SESSIONS = "0";
      if (options.contextBudget) env.AURORA_TOKEN_BUDGET = options.contextBudget;

      const config = loadConfig(env);
      const logger = createLogger(config.logLevel);
      const runtime = new AgentRuntime({ config, logger });

      // Fail loudly and specifically if the provider is unreachable. Reporting a
      // mock or an empty answer as success is exactly what the plan forbids.
      if (runtime.llm.health) {
        const healthy = await runtime.llm.health();
        if (!healthy) {
          process.stderr.write(
            `aurora: LLM provider "${runtime.llm.name}" is not reachable at ` +
              `${config.llmProvider === "ollama" ? config.ollamaBaseUrl : config.openAICompatibleBaseUrl}.\n` +
              `        Start the provider (e.g. \`ollama serve\`) or set AURORA_LLM_PROVIDER.\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      // `runTask` recalls prior sessions and persists this one (Phase 7).
      const result = await runtime.runTask(task);

      if (result.output) {
        process.stdout.write(`${result.output}\n`);
      } else {
        process.stdout.write("(no output)\n");
      }

      if (result.context?.compactions) {
        process.stderr.write(
          `aurora: context compacted ${result.context.compactions} time(s)` +
            (result.context.finalTokens !== undefined
              ? `; final ~${result.context.finalTokens} tokens`
              : "") +
            ".\n",
        );
      }
      if (result.context?.overBudget) {
        process.stderr.write(
          "aurora: context still exceeds the token budget after compaction.\n",
        );
      }

      if (result.status !== "completed") {
        process.stderr.write(
          `aurora: run ended with status "${result.status}" after ` +
            `${result.iterations} iteration(s), ${result.toolCalls} tool call(s).` +
            (result.error ? `\n        ${result.error}` : "") +
            "\n",
        );
        process.exitCode = 1;
      } else if (result.lastVerification?.kind === "skipped") {
        // The run "completed", but the external check never ran. Say so rather
        // than let a green status imply the work was verified.
        process.stderr.write(
          `aurora: completed WITHOUT verification (${result.lastVerification.reason ?? "skipped"}).\n`,
        );
      }
    });
}
