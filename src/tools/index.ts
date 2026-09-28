import type { Config } from "../config/Config.js";
import type { Logger } from "../observability/Logger.js";
import { PathValidator } from "../security/PathValidator.js";
import { CommandValidator } from "../security/CommandValidator.js";
import { PermissionManager, type Permission } from "../security/PermissionManager.js";
import { LocalExecutionProvider } from "../providers/execution/LocalExecutionProvider.js";
import { ToolRegistry } from "./ToolRegistry.js";
import { readFileTool } from "./filesystem/ReadFileTool.js";
import { writeFileTool } from "./filesystem/WriteFileTool.js";
import { listFilesTool } from "./filesystem/ListFilesTool.js";
import { runCommandTool } from "./execution/RunCommandTool.js";
import { resolve } from "node:path";

/**
 * The permission set granted to a run. Read-only plus workspace writes plus
 * command execution is the default; NETWORK_ACCESS is deliberately withheld
 * until Phase 3 introduces URL validation (ADR 004).
 */
export const DEFAULT_RUN_PERMISSIONS: readonly Permission[] = [
  "READ_ONLY",
  "WORKSPACE_WRITE",
  "COMMAND_EXECUTION",
];

export interface BuildToolRegistryOptions {
  config: Config;
  logger: Logger;
  permissions?: readonly Permission[];
  workspace?: string;
}

export function buildToolRegistry(opts: BuildToolRegistryOptions): ToolRegistry {
  const workspace = resolve(opts.workspace ?? opts.config.workspace);
  const pathValidator = new PathValidator([workspace]);
  pathValidator.ensureRootExists();

  const commandValidator = new CommandValidator({
    allowed: opts.config.allowedCommands,
    blocked: opts.config.blockedCommands,
  });

  const permissions = new PermissionManager(
    opts.permissions ?? DEFAULT_RUN_PERMISSIONS,
  );

  return new ToolRegistry({
    permissions,
    workspace,
    pathValidator,
    commandValidator,
    execution: new LocalExecutionProvider(),
    logger: opts.logger,
  }).registerAll([readFileTool, writeFileTool, listFilesTool, runCommandTool]);
}
