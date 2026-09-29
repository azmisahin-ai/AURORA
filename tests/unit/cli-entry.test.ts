import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * The CLI used to detect its entry point with
 * `process.argv[1].endsWith("cli/index.js")`. On Windows that string is
 * `C:\AURORA\dist\cli\index.js`, so the check was false and **every** command
 * exited silently with status 0 — no output, no error, no hint. It only
 * reproduced on Windows, so a Linux-only suite never saw it.
 *
 * `pathToFileURL`/`fileURLToPath` are platform-native, so a Windows path cannot
 * be simulated here. The regression is therefore guarded two ways that do work
 * on Linux: (1) a source scan that forbids the fragile suffix comparison, and
 * (2) actually spawning the CLI and asserting it is not silent.
 */

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const src = join(repoRoot, "src", "cli", "index.ts");
const built = join(repoRoot, "dist", "cli", "index.js");
const target = existsSync(built) ? built : src;
const runner = target === src ? ["--import", "tsx"] : [];

describe("CLI source guard", () => {
  it("does not detect its entry point by string suffix", () => {
    // A suffix check on `argv[1]` is separator-fragile and silently breaks on
    // Windows. The entry check must compare URLs or resolve paths, not match a
    // trailing literal.
    const source = readFileSync(src, "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/argv\[1\][^\n]*endsWith/);
    expect(code).toMatch(/pathToFileURL/);
  });
});

describe("CLI entry point runs (not silent)", () => {
  it("prints a version", async () => {
    const { stdout } = await run(process.execPath, [...runner, target, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints usage when invoked bare", async () => {
    // Commander prints help for a bare invocation with subcommands; the point is
    // that it says *something*, which the Windows bug prevented.
    const result = await run(process.execPath, [...runner, target]).catch((e) => e);
    expect(String(result.stdout) + String(result.stderr)).toContain("Usage: aurora");
  });

  it("fails loudly when the provider is unreachable", async () => {
    // The Windows symptom was exit 0 with no output. An unreachable provider
    // must be exit 1 with a message.
    const result = await run(
      process.execPath,
      [...runner, target, "run", "Merhaba de"],
      { env: { ...process.env, OLLAMA_BASE_URL: "http://127.0.0.1:1" }, timeout: 30_000 },
    ).catch((e) => e);
    expect(result.code).toBe(1);
    expect(String(result.stdout) + String(result.stderr)).toMatch(/not reachable|unreachable/i);
  });
});
