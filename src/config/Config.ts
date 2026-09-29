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

  // Verification (Phase 4). The external check is a command; when unset, no
  // verifier is built and completion is accepted as-is (pre-Phase-4 behaviour).
  // `maxVerifications` bounds the verify→repair loop; 0 disables it.
  testCommand: z.string().default(""),
  testTimeoutMs: z.coerce.number().int().positive().default(300_000),
  maxVerifications: z.coerce.number().int().min(0).default(0),

  // Sub-agents (Phase 5). 0 disables delegation entirely, which is the
  // pre-Phase-5 behaviour: no `delegate` tool is registered and no role
  // toolsets are built. Each role also has its own per-delegation budget
  // (see `core/agent/roles/definitions.ts`).
  maxSubAgents: z.coerce.number().int().min(0).default(3),

  // Task persistence (Phase 6). Where durable task records live and how many
  // attempts a task gets before it is failed rather than requeued.
  taskDir: z.string().min(1).default("./tasks"),
  taskMaxAttempts: z.coerce.number().int().positive().default(3),

  // Memory (Phase 7). Session records are the durable "session" tier; recall
  // injects a bounded summary of the most recent prior sessions into a new run.
  // 0 disables recall. Recall is a no-op when no sessions exist yet, so the
  // default does not change first-run behaviour.
  sessionDir: z.string().min(1).default("./sessions"),
  recallSessions: z.coerce.number().int().min(0).default(3),

  // Web research. `duckduckgo` is the keyless default: it scrapes DDG's HTML
  // endpoint, so `research` finds sources with no credential. `noop` disables
  // search entirely (fetch-known-URLs only). Keyed providers sit behind the
  // same interface and can be added without touching the loop.
  searchProvider: z.enum(["duckduckgo", "noop"]).default("duckduckgo"),
  fetchTimeoutMs: z.coerce.number().int().positive().default(30_000),
  fetchMaxBytes: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  /** Cap on characters of untrusted content injected into context. */
  untrustedMaxChars: z.coerce.number().int().positive().default(32_000),

  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  /** Scrub credential shapes out of log events (ADR 010). */
  redactLogs: booleanFromString().default(true),

  // Security hardening (Phase 8). `maxArgumentBytes` caps a single tool call;
  // the rate limit is a per-tool token bucket (`0` disables it). `confirmMode`
  // decides what happens before a state-changing tool runs: `allow` proceeds
  // (unattended default), `prompt` asks, `deny` refuses. `prompt` falls back to
  // proceeding when there is no interactive input, unless `confirmStrict`.
  maxArgumentBytes: z.coerce.number().int().positive().default(64 * 1024),
  toolRateLimit: z.coerce.number().int().min(0).default(20),
  toolRateRefill: z.coerce.number().positive().default(1),
  confirmMode: z.enum(["allow", "deny", "prompt"]).default("allow"),
  confirmStrict: booleanFromString().default(false),

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

  // HTTP API (Phase 9, ADR 011). Loopback by default; a non-loopback bind is
  // refused at startup unless `apiToken` is set. `apiAllowMutation` defaults to
  // false so an HTTP run uses a deny-all gate: a state-changing tool is refused
  // because there is no one at a terminal to confirm it. Tokens are compared
  // in constant time and never logged.
  apiHost: z.string().min(1).default("127.0.0.1"),
  apiPort: z.coerce.number().int().min(0).max(65_535).default(8787),
  apiToken: z.string().default(""),
  apiAllowMutation: booleanFromString().default(false),
  apiMaxBodyBytes: z.coerce.number().int().positive().default(256 * 1024),
  apiRateLimit: z.coerce.number().int().min(0).default(60),
  apiRateRefill: z.coerce.number().positive().default(1),
  apiMaxConcurrentRuns: z.coerce.number().int().positive().default(2),
  apiMaxSyncMs: z.coerce.number().int().positive().default(30_000),

  // UI (Phase 10, ADR 012). Served by the API on `/` and `/ui/*` when the
  // directory exists; the shell is public, every data route still needs the
  // token. Empty disables the static route entirely.
  uiDir: z.string().default("./ui"),
});

export type Config = z.infer<typeof ConfigSchema>;

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Env-var boolean. `z.coerce.boolean()` is `Boolean(value)`, so the string
 * "false" would become `true`; an env var that says `false` must mean false.
 */
function booleanFromString() {
  return z.union([z.boolean(), z.string()]).transform((value, ctx) => {
    if (typeof value === "boolean") return value;
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(lowered)) return true;
    if (["0", "false", "no", "off", ""].includes(lowered)) return false;
    ctx.addIssue({ code: "custom", message: `Not a boolean: ${JSON.stringify(value)}` });
    return z.NEVER;
  });
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

    testCommand: env.AURORA_TEST_COMMAND,
    testTimeoutMs: env.AURORA_TEST_TIMEOUT_MS,
    maxVerifications: env.AURORA_MAX_VERIFICATIONS,

    maxSubAgents: env.AURORA_MAX_SUB_AGENTS,

    taskDir: env.AURORA_TASK_DIR,
    taskMaxAttempts: env.AURORA_TASK_MAX_ATTEMPTS,

    sessionDir: env.AURORA_SESSION_DIR,
    recallSessions: env.AURORA_RECALL_SESSIONS,

    searchProvider: env.AURORA_SEARCH_PROVIDER,
    fetchTimeoutMs: env.AURORA_FETCH_TIMEOUT_MS,
    fetchMaxBytes: env.AURORA_FETCH_MAX_BYTES,
    untrustedMaxChars: env.AURORA_UNTRUSTED_MAX_CHARS,

    logLevel: env.AURORA_LOG_LEVEL,
    redactLogs: env.AURORA_REDACT_LOGS,

    maxArgumentBytes: env.AURORA_MAX_ARGUMENT_BYTES,
    toolRateLimit: env.AURORA_TOOL_RATE_LIMIT,
    toolRateRefill: env.AURORA_TOOL_RATE_REFILL,
    confirmMode: env.AURORA_CONFIRM_MODE,
    confirmStrict: env.AURORA_CONFIRM_STRICT,

    allowedCommands: splitList(env.AURORA_ALLOWED_COMMANDS),
    blockedCommands: splitList(env.AURORA_BLOCKED_COMMANDS),

    apiHost: env.AURORA_API_HOST,
    apiPort: env.AURORA_API_PORT,
    apiToken: env.AURORA_API_TOKEN,
    apiAllowMutation: env.AURORA_API_ALLOW_MUTATION,
    apiMaxBodyBytes: env.AURORA_API_MAX_BODY_BYTES,
    apiRateLimit: env.AURORA_API_RATE_LIMIT,
    apiRateRefill: env.AURORA_API_RATE_REFILL,
    apiMaxConcurrentRuns: env.AURORA_API_MAX_CONCURRENT_RUNS,
    apiMaxSyncMs: env.AURORA_API_MAX_SYNC_MS,

    uiDir: env.AURORA_UI_DIR,
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
