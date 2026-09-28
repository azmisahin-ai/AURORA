import { z } from "zod";

/**
 * Configuration schema. All values come from environment variables; nothing is
 * read from disk implicitly. Validation happens once, at startup, so a
 * misconfiguration surfaces before any network call is made.
 */
export const ConfigSchema = z.object({
  llmProvider: z.enum(["ollama", "openai-compatible"]).default("ollama"),
  model: z.string().min(1).default("llama3.2"),
  ollamaBaseUrl: z.string().url().default("http://localhost:11434"),
  openAICompatibleBaseUrl: z.string().default(""),
  openAICompatibleApiKey: z.string().default(""),

  workspace: z.string().min(1).default("./workspace"),
  knowledgeDir: z.string().min(1).default("./knowledge"),

  maxIterations: z.coerce.number().int().positive().default(25),
  maxToolCalls: z.coerce.number().int().positive().default(50),
  timeoutMs: z.coerce.number().int().positive().default(120_000),
  tokenBudget: z.coerce.number().int().positive().default(100_000),

  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),

  allowedCommands: z.array(z.string()).default([
    "npm",
    "node",
    "npx",
    "git",
    "ls",
    "cat",
    "echo",
  ]),
  blockedCommands: z.array(z.string()).default(["rm", "curl", "wget", "ssh", "scp"]),
});

export type Config = z.infer<typeof ConfigSchema>;

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const DEFAULT_ALLOWED = ["npm", "node", "npx", "git", "ls", "cat", "echo"];
const DEFAULT_BLOCKED = ["rm", "curl", "wget", "ssh", "scp"];

/** Build a Config from an environment-like record. Throws on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, unknown> = {
    llmProvider: env.AURORA_LLM_PROVIDER,
    model: env.AURORA_MODEL,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    openAICompatibleBaseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
    openAICompatibleApiKey: env.OPENAI_COMPATIBLE_API_KEY,

    workspace: env.AURORA_WORKSPACE,
    knowledgeDir: env.AURORA_KNOWLEDGE_DIR,

    maxIterations: env.AURORA_MAX_ITERATIONS,
    maxToolCalls: env.AURORA_MAX_TOOL_CALLS,
    timeoutMs: env.AURORA_TIMEOUT_MS,
    tokenBudget: env.AURORA_TOKEN_BUDGET,

    logLevel: env.AURORA_LOG_LEVEL,

    allowedCommands: splitList(env.AURORA_ALLOWED_COMMANDS),
    blockedCommands: splitList(env.AURORA_BLOCKED_COMMANDS),
  };

  // Strip undefined so zod .default() applies uniformly, then apply list
  // defaults explicitly (arrays behave inconsistently without this).
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) cleaned[key] = value;
  }
  if (cleaned.allowedCommands === undefined) cleaned.allowedCommands = DEFAULT_ALLOWED;
  if (cleaned.blockedCommands === undefined) cleaned.blockedCommands = DEFAULT_BLOCKED;

  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid AURORA configuration:\n${issues}`);
  }
  return parsed.data;
}

export const defaults = {
  allowedCommands: DEFAULT_ALLOWED,
  blockedCommands: DEFAULT_BLOCKED,
} as const;
