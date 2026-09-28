import { describe, it, expect } from "vitest";
import { DirectFetcher } from "../../../src/providers/web/DirectFetcher.js";
import { UrlValidator, UrlValidationError } from "../../../src/security/UrlValidator.js";

/**
 * These tests assert that a dangerous target is refused *before* any socket is
 * opened. The resolver is injected, so no real DNS lookup or connection occurs;
 * if validation were skipped the test would hang or fail on connect.
 */
describe("DirectFetcher SSRF containment", () => {
  it("refuses a hostname that resolves to loopback, without connecting", async () => {
    const validator = new UrlValidator({ resolve: async () => ["127.0.0.1"] });
    const fetcher = new DirectFetcher(validator);
    await expect(fetcher.fetch({ url: "http://internal.example.com/" })).rejects.toThrow(
      UrlValidationError,
    );
  });

  it("refuses a hostname that resolves to the cloud metadata address", async () => {
    const validator = new UrlValidator({ resolve: async () => ["169.254.169.254"] });
    const fetcher = new DirectFetcher(validator);
    await expect(
      fetcher.fetch({ url: "http://metadata.example.com/latest/meta-data/" }),
    ).rejects.toThrow(/non-routable/i);
  });

  it("refuses a non-http scheme before connecting", async () => {
    const validator = new UrlValidator({ resolve: async () => ["93.184.216.34"] });
    const fetcher = new DirectFetcher(validator);
    await expect(fetcher.fetch({ url: "file:///etc/passwd" })).rejects.toThrow(
      UrlValidationError,
    );
  });

  it("refuses a literal private address before connecting", async () => {
    const validator = new UrlValidator();
    const fetcher = new DirectFetcher(validator);
    await expect(fetcher.fetch({ url: "http://10.1.2.3/" })).rejects.toThrow(
      UrlValidationError,
    );
  });
});
