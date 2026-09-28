import type { Config } from "../config/Config.js";
import type { Logger } from "../observability/Logger.js";
import { PathValidator } from "../security/PathValidator.js";
import { CommandValidator } from "../security/CommandValidator.js";
import { UrlValidator } from "../security/UrlValidator.js";
import {
  ALL_PERMISSIONS,
  PermissionManager,
  type Permission,
} from "../security/PermissionManager.js";
import { LocalExecutionProvider } from "../providers/execution/LocalExecutionProvider.js";
import { DirectFetcher } from "../providers/web/DirectFetcher.js";
import { NoopSearchProvider } from "../providers/web/search/NoopSearchProvider.js";
import type { SearchProvider } from "../providers/web/search/SearchProvider.js";
import { FileKnowledgeStore } from "../core/knowledge/FileKnowledgeStore.js";
import type { KnowledgeStore } from "../core/knowledge/KnowledgeStore.js";
import { ToolRegistry } from "./ToolRegistry.js";
import type { Tool } from "./types.js";
import { readFileTool } from "./filesystem/ReadFileTool.js";
import { writeFileTool } from "./filesystem/WriteFileTool.js";
import { listFilesTool } from "./filesystem/ListFilesTool.js";
import { runCommandTool } from "./execution/RunCommandTool.js";
import { runTestsTool } from "./execution/RunTestsTool.js";
import { webFetchTool } from "./web/WebFetchTool.js";
import { webSearchTool } from "./web/WebSearchTool.js";
import { knowledgeWriteTool } from "./knowledge/KnowledgeWriteTool.js";
import { knowledgeSearchTool } from "./knowledge/KnowledgeSearchTool.js";
import { delegateTool } from "./agent/DelegateTool.js";
import { roleDefinition, type AgentRole } from "../core/agent/roles/index.js";
import type {
  RoleToolsetBuilder,
  SubAgentManagerPort,
} from "../core/agent/subagent/index.js";
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
  /**
   * When supplied, a `delegate` tool is registered into the parent registry and
   * role-scoped toolsets become available. Omit it and the build is exactly the
   * pre-Phase-5 registry — a run without sub-agents behaves as before.
   */
  subAgentManager?: SubAgentManagerPort;
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
  /**
   * Builds a permission-scoped tool registry for a sub-agent role. Provided by
   * the tool layer so `core` never touches concrete tools.
   */
  roleToolsetBuilder: RoleToolsetBuilder;
}

/**
 * Permissions a sub-agent may hold: the intersection of what the parent run was
 * granted and what the role is capped at. `FULL_ACCESS` is never propagated —
 * a role holds the explicit permissions its tools need, nothing more.
 */
function intersectPermissions(
  parent: PermissionManager,
  cap: readonly Permission[],
): Permission[] {
  return ALL_PERMISSIONS.filter(
    (p) => p !== "FULL_ACCESS" && parent.has(p) && cap.includes(p),
  );
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

  // The catalog is every real tool *except* `delegate`. Role registries are
  // built from it, which is what makes `delegate` structurally unavailable to
  // sub-agents: it is not that they are forbidden to call it, it is that the
  // tool does not exist in their registry. Recursion is bounded by
  // construction, not by a depth check that could be bypassed.
  const catalog: Tool[] = [
    readFileTool,
    writeFileTool,
    listFilesTool,
    runCommandTool,
    webFetchTool(fetcher),
    webSearchTool(search),
    knowledgeWriteTool(knowledge),
    knowledgeSearchTool(knowledge),
  ];

  // The test tool is how the model checks its own work; it only exists when a
  // test command is configured. Without one there is nothing to run, and
  // offering a tool that always fails would be worse than omitting it.
  if (opts.config.testCommand.trim() !== "") {
    catalog.push(
      runTestsTool({
        command: opts.config.testCommand,
        defaultTimeoutMs: opts.config.testTimeoutMs,
      }),
    );
  }

  const byName = new Map(catalog.map((t) => [t.name, t]));

  const makeRegistry = (tools: readonly Tool[], granted: PermissionManager): ToolRegistry =>
    new ToolRegistry({
      permissions: granted,
      workspace,
      pathValidator,
      commandValidator,
      execution,
      logger: opts.logger,
    }).registerAll([...tools]);

  const parentTools: Tool[] = [...catalog];
  if (opts.subAgentManager) parentTools.push(delegateTool(opts.subAgentManager));
  const registry = makeRegistry(parentTools, permissions);

  const roleToolsetBuilder: RoleToolsetBuilder = {
    build(role: AgentRole) {
      const definition = roleDefinition(role);
      const granted = intersectPermissions(permissions, definition.maxPermissions);
      const grantedManager = new PermissionManager(granted);
      const tools = definition.tools
        .map((name) => byName.get(name))
        .filter((t): t is Tool => t !== undefined)
        // Belt and braces: a role's tool list and its permission cap must agree.
        // A tool the role lists but cannot afford is dropped, not silently
        // offered and then denied at call time.
        .filter((t) => grantedManager.allows(t.requiredPermissions));
      return { tools: makeRegistry(tools, grantedManager), permissions: granted };
    },
  };

  return {
    registry,
    knowledge,
    search,
    commandValidator,
    permissions,
    execution,
    workspace,
    roleToolsetBuilder,
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
