import { describe, it, expect } from "vitest";
import { DirectFetcher } from "../../src/providers/web/DirectFetcher.js";
import { UrlValidator } from "../../src/security/UrlValidator.js";
import { webFetchTool } from "../../src/tools/web/WebFetchTool.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { PermissionManager } from "../../src/security/PermissionManager.js";
import { PathValidator } from "../../src/security/PathValidator.js";
import { CommandValidator } from "../../src/security/CommandValidator.js";
import { LocalExecutionProvider } from "../../src/providers/execution/LocalExecutionProvider.js";
import { createLogger } from "../../src/observability/Logger.js";

/**
 * Live network test: reaches real public hosts and confirms that internal
 * targets are refused against *real* DNS, not an injected resolver.
 *
 * If there is no network egress this test SKIPS — it is never reported as a
 * pass. When egress exists, a failure is a real failure.
 *
 * Env switches:
 *   AURORA_TEST_NETWORK=0   force-skip
 *   AURORA_TEST_NETWORK=1   force-run (fails rather than skips if unreachable)
 */

const force = process.env.AURORA_TEST_NETWORK;

async function online(): Promise<boolean> {
  try {
    const res = await fetch("https://example.com/", {
      method: "HEAD",
      signal: AbortSignal.timeout(8_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

const reachable = force === "0" ? false : await online();
const shouldRun = force === "1" ? true : reachable;

if (!shouldRun) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n[integration] SKIP: no network egress — live web test skipped, NOT passed.\n",
  );
}

describe.skipIf(!shouldRun)("web_fetch ↔ live internet", () => {
  const logger = createLogger("silent");
  const registry = new ToolRegistry({
    permissions: new PermissionManager(["READ_ONLY", "NETWORK_ACCESS"]),
    workspace: process.cwd(),
    pathValidator: new PathValidator([process.cwd()]),
    commandValidator: new CommandValidator({ allowed: [] }),
    execution: new LocalExecutionProvider(),
    logger,
  }).register(webFetchTool(new DirectFetcher(new UrlValidator())));

  it(
    "fetches a real public page and returns markdown",
    async () => {
      const result = await registry.execute({
        name: "web_fetch",
        arguments: { url: "https://example.com/", maxChars: 8_000 },
      });
      expect(result.ok).toBe(true);
      expect(result.observation).toContain("HTTP 200");
      // The IANA example page has a stable heading and body text.
      expect(result.observation.toLowerCase()).toContain("example domain");
      // And it is wrapped, because it is untrusted.
      expect(result.observation).toContain("UNTRUSTED DATA");
    },
    60_000,
  );

  it(
    "refuses the cloud metadata endpoint against real resolution",
    async () => {
      const result = await registry.execute({
        name: "web_fetch",
        arguments: { url: "http://169.254.169.254/latest/meta-data/" },
      });
      expect(result.ok).toBe(false);
      expect(result.observation).toMatch(/routable/i);
    },
    30_000,
  );

  it(
    "refuses localhost against real resolution",
    async () => {
      const result = await registry.execute({
        name: "web_fetch",
        arguments: { url: "http://localhost:11434/api/tags" },
      });
      expect(result.ok).toBe(false);
      expect(result.observation).toMatch(/routable/i);
    },
    30_000,
  );

  it(
    "refuses a hostname that resolves to a private address",
    async () => {
      // 127.0.0.1.nip.io is a public DNS name that deliberately resolves to
      // 127.0.0.1 — the classic SSRF bypass against literal-only checks.
      const result = await registry.execute({
        name: "web_fetch",
        arguments: { url: "http://127.0.0.1.nip.io/" },
      });
      expect(result.ok).toBe(false);
      expect(result.observation).toMatch(/routable/i);
    },
    30_000,
  );
});
