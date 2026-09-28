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
});
