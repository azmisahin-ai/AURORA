import { describe, expect, it } from "vitest";
import { loadConfig, ConfigSchema, defaults } from "../../src/config/Config.js";

describe("Config", () => {
  it("applies documented defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.llmProvider).toBe("ollama");
    expect(config.model).toBe("llama3.2");
    expect(config.ollamaBaseUrl).toBe("http://localhost:11434");
    expect(config.workspace).toBe("./workspace");
    expect(config.knowledgeDir).toBe("./knowledge");
    expect(config.maxIterations).toBe(25);
    expect(config.maxToolCalls).toBe(50);
    expect(config.timeoutMs).toBe(120_000);
    expect(config.tokenBudget).toBe(100_000);
    expect(config.logLevel).toBe("info");
    expect(config.allowedCommands).toEqual(defaults.allowedCommands);
    expect(config.blockedCommands).toEqual(defaults.blockedCommands);
    expect(config.searchProvider).toBe("duckduckgo");
    expect(config.fetchTimeoutMs).toBe(30_000);
    expect(config.fetchMaxBytes).toBe(5 * 1024 * 1024);
    expect(config.untrustedMaxChars).toBe(32_000);
    // Verification is opt-in: no test command and no budget by default means
    // Phase 4 changes nothing unless a project configures it.
    expect(config.testCommand).toBe("");
    expect(config.testTimeoutMs).toBe(300_000);
    expect(config.maxVerifications).toBe(0);
    // Task persistence (Phase 6).
    expect(config.taskDir).toBe("./tasks");
    expect(config.taskMaxAttempts).toBe(3);
  });

  it("reads task settings from the environment", () => {
    const config = loadConfig({
      AURORA_TASK_DIR: "/tmp/jobs",
      AURORA_TASK_MAX_ATTEMPTS: "5",
    });
    expect(config.taskDir).toBe("/tmp/jobs");
    expect(config.taskMaxAttempts).toBe(5);
  });

  it("rejects a non-positive task attempt budget", () => {
    expect(() => loadConfig({ AURORA_TASK_MAX_ATTEMPTS: "0" })).toThrow(
      /Invalid AURORA configuration/,
    );
  });

  it("reads verification settings from the environment", () => {
    const config = loadConfig({
      AURORA_TEST_COMMAND: "npm test",
      AURORA_TEST_TIMEOUT_MS: "45000",
      AURORA_MAX_VERIFICATIONS: "3",
    });
    expect(config.testCommand).toBe("npm test");
    expect(config.testTimeoutMs).toBe(45_000);
    expect(config.maxVerifications).toBe(3);
  });

  it("defaults the LLM model to a concrete value but reads it from env", () => {
    expect(loadConfig({}).model).toBe("llama3.2");
    expect(loadConfig({ AURORA_MODEL: "qwen3.5:4b" }).model).toBe("qwen3.5:4b");
  });

  it("reads web-research settings from the environment", () => {
    const config = loadConfig({
      AURORA_SEARCH_PROVIDER: "noop",
      AURORA_FETCH_TIMEOUT_MS: "9000",
      AURORA_FETCH_MAX_BYTES: "1024",
      AURORA_UNTRUSTED_MAX_CHARS: "500",
    });
    expect(config.searchProvider).toBe("noop");
    expect(config.fetchTimeoutMs).toBe(9000);
    expect(config.fetchMaxBytes).toBe(1024);
    expect(config.untrustedMaxChars).toBe(500);
  });

  it("coerces numeric env vars from strings", () => {
    const config = loadConfig({
      AURORA_MAX_ITERATIONS: "7",
      AURORA_MAX_TOOL_CALLS: "3",
      AURORA_TIMEOUT_MS: "5000",
    });
    expect(config.maxIterations).toBe(7);
    expect(config.maxToolCalls).toBe(3);
    expect(config.timeoutMs).toBe(5000);
  });

  it("parses comma-separated command lists and strips whitespace", () => {
    const config = loadConfig({
      AURORA_ALLOWED_COMMANDS: " npm , node ,, echo ",
    });
    expect(config.allowedCommands).toEqual(["npm", "node", "echo"]);
  });

  it("rejects an unknown provider", () => {
    expect(() => loadConfig({ AURORA_LLM_PROVIDER: "gemini" })).toThrow(
      /Invalid AURORA configuration/,
    );
  });

  it("rejects a non-numeric numeric field", () => {
    expect(() => loadConfig({ AURORA_MAX_ITERATIONS: "lots" })).toThrow(
      /maxIterations/,
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => loadConfig({ OLLAMA_BASE_URL: "not-a-url" })).toThrow(
      /ollamaBaseUrl/,
    );
  });

  it("rejects zero or negative limits", () => {
    expect(() => loadConfig({ AURORA_MAX_ITERATIONS: "0" })).toThrow();
    expect(() => loadConfig({ AURORA_TIMEOUT_MS: "-1" })).toThrow();
  });

  it("exposes a schema whose parse matches loadConfig output shape", () => {
    const parsed = ConfigSchema.parse({
      allowedCommands: defaults.allowedCommands,
      blockedCommands: defaults.blockedCommands,
    });
    expect(parsed.llmProvider).toBe("ollama");
  });

  it("defaults Phase 8 hardening to the unattended-safe values", () => {
    const config = loadConfig({});
    expect(config.redactLogs).toBe(true);
    expect(config.maxArgumentBytes).toBe(64 * 1024);
    expect(config.toolRateLimit).toBe(20);
    expect(config.toolRateRefill).toBe(1);
    expect(config.confirmMode).toBe("allow");
    expect(config.confirmStrict).toBe(false);
  });

  it("reads Phase 8 hardening settings from the environment", () => {
    const config = loadConfig({
      AURORA_REDACT_LOGS: "false",
      AURORA_MAX_ARGUMENT_BYTES: "2048",
      AURORA_TOOL_RATE_LIMIT: "0",
      AURORA_TOOL_RATE_REFILL: "2",
      AURORA_CONFIRM_MODE: "deny",
      AURORA_CONFIRM_STRICT: "true",
    });
    expect(config.redactLogs).toBe(false);
    expect(config.maxArgumentBytes).toBe(2048);
    expect(config.toolRateLimit).toBe(0);
    expect(config.toolRateRefill).toBe(2);
    expect(config.confirmMode).toBe("deny");
    expect(config.confirmStrict).toBe(true);
  });

  it("treats the string 'false' as false, not truthy", () => {
    // A regression guard: z.coerce.boolean() would make this `true`.
    expect(loadConfig({ AURORA_REDACT_LOGS: "false" }).redactLogs).toBe(false);
    expect(loadConfig({ AURORA_CONFIRM_STRICT: "0" }).confirmStrict).toBe(false);
  });

  it("rejects an unknown confirm mode", () => {
    expect(() => loadConfig({ AURORA_CONFIRM_MODE: "ask" })).toThrow(/confirmMode/);
  });

  it("defaults the HTTP API to a safe, loopback-only, non-mutating bind", () => {
    const config = loadConfig({});
    expect(config.apiHost).toBe("127.0.0.1");
    expect(config.apiPort).toBe(8787);
    expect(config.apiToken).toBe("");
    expect(config.apiAllowMutation).toBe(false);
    expect(config.apiMaxBodyBytes).toBe(256 * 1024);
    expect(config.apiRateLimit).toBe(60);
    expect(config.apiMaxConcurrentRuns).toBe(2);
    expect(config.apiMaxSyncMs).toBe(30_000);
  });

  it("reads Phase 9 API settings from the environment", () => {
    const config = loadConfig({
      AURORA_API_HOST: "0.0.0.0",
      AURORA_API_PORT: "9000",
      AURORA_API_TOKEN: "t",
      AURORA_API_ALLOW_MUTATION: "true",
      AURORA_API_MAX_BODY_BYTES: "1024",
      AURORA_API_RATE_LIMIT: "0",
      AURORA_API_RATE_REFILL: "5",
      AURORA_API_MAX_CONCURRENT_RUNS: "4",
      AURORA_API_MAX_SYNC_MS: "1000",
    });
    expect(config.apiHost).toBe("0.0.0.0");
    expect(config.apiPort).toBe(9000);
    expect(config.apiToken).toBe("t");
    expect(config.apiAllowMutation).toBe(true);
    expect(config.apiMaxBodyBytes).toBe(1024);
    expect(config.apiRateLimit).toBe(0);
    expect(config.apiRateRefill).toBe(5);
    expect(config.apiMaxConcurrentRuns).toBe(4);
    expect(config.apiMaxSyncMs).toBe(1000);
  });

  it("treats the string 'false' as false for API mutation, and rejects a bad port", () => {
    expect(loadConfig({ AURORA_API_ALLOW_MUTATION: "false" }).apiAllowMutation).toBe(false);
    expect(() => loadConfig({ AURORA_API_PORT: "70000" })).toThrow(/apiPort/);
  });
});
