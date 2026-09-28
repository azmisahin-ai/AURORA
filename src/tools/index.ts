import type { Config } from "../config/Config.js";
import type { Logger } from "../observability/Logger.js";
import { PathValidator } from "../security/PathValidator.js";
import { CommandValidator } from "../security/CommandValidator.js";
import { UrlValidator } from "../security/UrlValidator.js";
import { PermissionManager, type Permission } from "../security/PermissionManager.js";
import { LocalExecutionProvider } from "../providers/execution/LocalExecutionProvider.js";
import { DirectFetcher } from "../providers/web/DirectFetcher.js";
import { NoopSearchProvider } from "../providers/web/search/NoopSearchProvider.js";
import type { SearchProvider } from "../providers/web/search/SearchProvider.js";
import { FileKnowledgeStore } from "../core/knowledge/FileKnowledgeStore.js";
import type { KnowledgeStore } from "../core/knowledge/KnowledgeStore.js";
import { ToolRegistry } from "./ToolRegistry.js";
import { readFileTool } from "./filesystem/ReadFileTool.js";
import { writeFileTool } from "./filesystem/WriteFileTool.js";
import { listFilesTool } from "./filesystem/ListFilesTool.js";
import { runCommandTool } from "./execution/RunCommandTool.js";
import { runTestsTool } from "./execution/RunTestsTool.js";
import { webFetchTool } from "./web/WebFetchTool.js";
import { webSearchTool } from "./web/WebSearchTool.js";
import { knowledgeWriteTool } from "./knowledge/KnowledgeWriteTool.js";
import { knowledgeSearchTool } from "./knowledge/KnowledgeSearchTool.js";
import { resolve } from "node:path";

/**
 * Permissions granted to a run by default. `NETWORK_ACCESS` is now included
 * because Phase 3 ships `UrlValidator` + SSRF-contained fetching; the control
 * that makes it safe is URL validation, not withholding the permission.
 */
export const DEFAULT_RUN_PERMISSIONS: readonly Permission[] = [
  "READ_ONLY",
  "WORKSPACE_WRITE",
  "COMMAND_EXECUTION",
  "NETWORK_ACCESS",
];

export interface BuildToolRegistryOptions {
  config: Config;
  logger: Logger;
  permissions?: readonly Permission[];
  workspace?: string;
  knowledgeStore?: KnowledgeStore;
  searchProvider?: SearchProvider;
  /** Allow loopback/private fetch targets. Tests only. */
  allowPrivateNetwork?: boolean;
}

export interface BuiltTools {
  registry: ToolRegistry;
  knowledge: KnowledgeStore;
  search: SearchProvider;
  /**
   * Security/execution pieces the runtime needs to build the verifier. Exposed
   * rather than rebuilt so the verifier and the tools share one permission
   * grant and one command policy — a verifier that used a different allowlist
   * than `run_tests` would be a silent inconsistency.
   */
  commandValidator: CommandValidator;
  permissions: PermissionManager;
  execution: LocalExecutionProvider;
  workspace: string;
}

export function buildToolRegistry(opts: BuildToolRegistryOptions): BuiltTools {
  const workspace = resolve(opts.workspace ?? opts.config.workspace);
  const pathValidator = new PathValidator([workspace]);
  pathValidator.ensureRootExists();

  const commandValidator = new CommandValidator({
    allowed: opts.config.allowedCommands,
    blocked: opts.config.blockedCommands,
  });

  const permissions = new PermissionManager(opts.permissions ?? DEFAULT_RUN_PERMISSIONS);

  const urlValidator = new UrlValidator(
    opts.allowPrivateNetwork ? { allowPrivate: true } : {},
  );
  const fetcher = new DirectFetcher(urlValidator, {
    ...(opts.allowPrivateNetwork ? { allowPrivate: true, pinConnections: false } : {}),
  });

  const knowledge = opts.knowledgeStore ?? new FileKnowledgeStore(opts.config.knowledgeDir);
  const search = opts.searchProvider ?? createSearchProvider(opts);
  const execution = new LocalExecutionProvider();

  const registry = new ToolRegistry({
    permissions,
    workspace,
    pathValidator,
    commandValidator,
    execution,
    logger: opts.logger,
  }).registerAll([
    readFileTool,
    writeFileTool,
    listFilesTool,
    runCommandTool,
    webFetchTool(fetcher),
    webSearchTool(search),
    knowledgeWriteTool(knowledge),
    knowledgeSearchTool(knowledge),
  ]);

  // The test tool is how the model checks its own work; it only exists when a
  // test command is configured. Without one there is nothing to run, and
  // offering a tool that always fails would be worse than omitting it.
  if (opts.config.testCommand.trim() !== "") {
    registry.register(
      runTestsTool({
        command: opts.config.testCommand,
        defaultTimeoutMs: opts.config.testTimeoutMs,
      }),
    );
  }

  return {
    registry,
    knowledge,
    search,
    commandValidator,
    permissions,
    execution,
    workspace,
  };
}

/**
 * No search backend ships in Phase 3: every candidate provider needs a
 * credential, and AURORA must work without one. The `noop` provider makes that
 * a supported mode rather than an error (ADR 003: no provider lock-in).
 */
function createSearchProvider(opts: BuildToolRegistryOptions): SearchProvider {
  switch (opts.config.searchProvider) {
    case "noop":
      return new NoopSearchProvider(opts.logger);
    default: {
      const exhaustive: never = opts.config.searchProvider;
      throw new Error(`Unsupported search provider: ${String(exhaustive)}`);
    }
  }
}
