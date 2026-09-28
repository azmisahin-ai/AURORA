import { describe, it, expect } from "vitest";
import {
  UrlValidator,
  UrlValidationError,
  isBlockedAddress,
} from "../../../src/security/UrlValidator.js";

describe("isBlockedAddress", () => {
  it("blocks loopback, link-local, private, CGNAT and reserved IPv4", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.255.254",
      "0.0.0.0",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "192.0.0.1", // IETF protocol assignments
      "198.18.0.1", // benchmarking
      "224.0.0.1", // multicast
      "255.255.255.255", // reserved
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.0.1"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("blocks IPv6 loopback, link-local, unique-local and multicast", () => {
    for (const address of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("blocks IPv4-mapped IPv6 in hex form (URL parser normalisation)", () => {
    // Node rewrites http://[::ffff:127.0.0.1]/ to the hex form below before we
    // see it, so a dotted-quad regex would miss these entirely.
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isBlockedAddress("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:808:808")).toBe(false); // 8.8.8.8, public
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks IPv4-compatible, NAT64 and 6to4 forms of a private address", () => {
    expect(isBlockedAddress("::7f00:1")).toBe(true); // IPv4-compatible 127.0.0.1
    expect(isBlockedAddress("64:ff9b::7f00:1")).toBe(true); // NAT64
    expect(isBlockedAddress("64:ff9b::808:808")).toBe(false); // NAT64 to 8.8.8.8
    expect(isBlockedAddress("2002:7f00:1::")).toBe(true); // 6to4 127.0.0.1
    expect(isBlockedAddress("2002:808:808::")).toBe(false); // 6to4 8.8.8.8
  });

  it("blocks IPv4-mapped IPv6 that smuggles a private address", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("strips an IPv6 zone id before deciding", () => {
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
  });

  it("treats localhost names as blocked", () => {
    expect(isBlockedAddress("localhost")).toBe(true);
    expect(isBlockedAddress("LOCALHOST")).toBe(true);
    expect(isBlockedAddress("api.localhost")).toBe(true);
    expect(isBlockedAddress("localhost.example.com")).toBe(false);
  });

  it("fails closed on an unparseable dotted address", () => {
    expect(isBlockedAddress("999.1.1.1")).toBe(true);
  });
});

describe("UrlValidator.validateSyntax", () => {
  const validator = new UrlValidator();

  it("accepts http and https", () => {
    expect(validator.validateSyntax("https://example.com/a?b=1").hostname).toBe("example.com");
    expect(validator.validateSyntax("http://example.com").protocol).toBe("http:");
  });

  it("rejects non-http schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)",
    ]) {
      expect(() => validator.validateSyntax(url), url).toThrow(UrlValidationError);
    }
  });

  it("rejects URLs carrying credentials", () => {
    expect(() => validator.validateSyntax("https://user:pass@example.com")).toThrow(
      /credentials/i,
    );
  });

  it("rejects literal loopback/link-local/private hosts", () => {
    for (const url of [
      "http://localhost/",
      "http://127.0.0.1:8080/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://[::1]/",
    ]) {
      expect(() => validator.validateSyntax(url), url).toThrow(UrlValidationError);
    }
  });

  it("rejects a malformed URL", () => {
    expect(() => validator.validateSyntax("not a url")).toThrow(UrlValidationError);
  });
});

describe("UrlValidator.validate (resolution)", () => {
  it("rejects a public hostname that resolves to a metadata address", async () => {
    const validator = new UrlValidator({
      resolve: async () => ["169.254.169.254"],
    });
    await expect(validator.validate("https://metadata.example.com/")).rejects.toThrow(
      /non-routable/i,
    );
  });

  it("rejects when ANY resolved address is internal (mixed answer)", async () => {
    const validator = new UrlValidator({
      resolve: async () => ["93.184.216.34", "10.0.0.5"],
    });
    await expect(validator.validate("https://mixed.example.com/")).rejects.toThrow(
      /non-routable/i,
    );
  });

  it("accepts a hostname resolving only to public addresses", async () => {
    const validator = new UrlValidator({ resolve: async () => ["93.184.216.34"] });
    const result = await validator.validate("https://example.com/");
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("rejects a hostname that resolves to nothing", async () => {
    const validator = new UrlValidator({ resolve: async () => [] });
    await expect(validator.validate("https://empty.example.com/")).rejects.toThrow(
      /did not resolve/i,
    );
  });

  it("does not resolve an IP literal", async () => {
    let called = false;
    const validator = new UrlValidator({
      resolve: async () => {
        called = true;
        return [];
      },
    });
    await validator.validate("https://93.184.216.34/");
    expect(called).toBe(false);
  });
});
