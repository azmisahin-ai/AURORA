import type { Command } from "commander";
import { loadConfig } from "../../config/Config.js";
import { createLogger } from "../../observability/Logger.js";
import { SecretRedactor } from "../../security/SecretRedactor.js";
import { AgentRuntime } from "../../core/agent/AgentRuntime.js";
import { FileTaskStore } from "../../core/task/FileTaskStore.js";
import { FileKnowledgeStore } from "../../core/knowledge/FileKnowledgeStore.js";
import { apiConfirmationGate, createApiServer } from "../../api/index.js";

export interface ServeCommandOptions {
  host?: string;
  port?: string;
  model?: string;
  allowMutation?: boolean;
}

/**
 * `aurora serve` — start the HTTP API (Phase 9, ADR 011).
 *
 * The runtime is built with a gate chosen from `AURORA_API_ALLOW_MUTATION`: with
 * the default `false`, an HTTP run uses a deny-all gate, so a state-changing
 * tool is refused because there is no terminal to confirm it. That is the whole
 * reason the Phase 8 `ConfirmationGate` seam exists; this command is where the
 * HTTP policy plugs into it.
 */
export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start the HTTP API")
    .option("--host <host>", "override AURORA_API_HOST (default 127.0.0.1)")
    .option("--port <n>", "override AURORA_API_PORT (0 picks a free port)")
    .option("--model <name>", "override AURORA_MODEL")
    .option("--allow-mutation", "let HTTP runs change the workspace (opt-in)")
    .action(async (options: ServeCommandOptions) => {
      const env = { ...process.env };
      if (options.host) env.AURORA_API_HOST = options.host;
      if (options.port) env.AURORA_API_PORT = options.port;
      if (options.model) env.AURORA_MODEL = options.model;
      if (options.allowMutation) env.AURORA_API_ALLOW_MUTATION = "true";

      const config = loadConfig(env);
      const logger = createLogger(config.logLevel);
      const redactor = config.redactLogs ? new SecretRedactor() : undefined;

      const runtime = new AgentRuntime({
        config,
        logger,
        confirmationGate: apiConfirmationGate(config.apiAllowMutation),
      });

      const api = createApiServer(
        {
          host: config.apiHost,
          port: config.apiPort,
          token: config.apiToken,
          maxBodyBytes: config.apiMaxBodyBytes,
          rateLimit: config.apiRateLimit,
          rateRefill: config.apiRateRefill,
          maxConcurrentRuns: config.apiMaxConcurrentRuns,
          maxSyncMs: config.apiMaxSyncMs,
        },
        {
          runtime,
          tasks: new FileTaskStore(config.taskDir),
          knowledge: new FileKnowledgeStore(config.knowledgeDir),
          logger,
          ...(redactor !== undefined ? { redactor } : {}),
        },
      );

      let bound: { host: string; port: number };
      try {
        bound = await api.listen();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(`aurora: ${message}\n`);
        process.exitCode = 1;
        return;
      }

      const auth = config.apiToken !== "" ? "token required" : "no auth (loopback only)";
      const mutation = config.apiAllowMutation ? "mutation allowed" : "mutation denied";
      process.stdout.write(
        `aurora api listening on http://${bound.host}:${bound.port} (${auth}; ${mutation})\n`,
      );

      const shutdown = async (signal: string): Promise<void> => {
        process.stdout.write(`aurora: ${signal} received, shutting down\n`);
        await api.close();
        process.exitCode = 0;
      };
      process.once("SIGINT", () => void shutdown("SIGINT"));
      process.once("SIGTERM", () => void shutdown("SIGTERM"));
    });
}
