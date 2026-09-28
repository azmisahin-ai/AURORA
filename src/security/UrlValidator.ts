import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class UrlValidationError extends Error {
  readonly url: string;
  constructor(message: string, url: string) {
    super(message);
    this.name = "UrlValidationError";
    this.url = url;
  }
}

/** A URL that passed validation, with the addresses it resolved to. */
export interface ValidatedUrl {
  url: URL;
  /** Vetted, globally routable addresses the host resolved to. */
  addresses: string[];
}

/**
 * SSRF defence for outbound requests.
 *
 * Two checks, both required:
 *  1. **Syntactic** — scheme must be http/https, no credentials in the URL, and
 *     a host that is not a literal blocked address.
 *  2. **Resolution** — the hostname is resolved and *every* returned address
 *     must be globally routable. Rejecting only literals is insufficient: a
 *     hostname such as `metadata.example.com` can resolve to 169.254.169.254.
 *
 * Residual risk: resolution here and connection later are separate steps, so a
 * DNS answer that changes between them (DNS rebinding) could still reach an
 * internal address. `Fetcher` mitigates this by pinning the connection to the
 * address validated here; see `DirectFetcher`.
 */
export class UrlValidator {
  constructor(
    private readonly opts: {
      allowedProtocols?: readonly string[];
      /** Override the resolver, for tests. */
      resolve?: (hostname: string) => Promise<string[]>;
      /** Allow loopback/private hosts. Only for tests against a local server. */
      allowPrivate?: boolean;
    } = {},
  ) {}

  private get allowedProtocols(): readonly string[] {
    return this.opts.allowedProtocols ?? ["http:", "https:"];
  }

  /** Syntactic validation only — no network I/O. */
  validateSyntax(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UrlValidationError(`Not a valid URL: ${raw}`, raw);
    }
    if (!this.allowedProtocols.includes(url.protocol)) {
      throw new UrlValidationError(
        `Protocol "${url.protocol}" is not allowed (only ${this.allowedProtocols.join(", ")})`,
        raw,
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new UrlValidationError("URLs with embedded credentials are not allowed", raw);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!this.opts.allowPrivate && isBlockedAddress(host)) {
      throw new UrlValidationError(`Address "${host}" is not routable on the public internet`, raw);
    }
    return url;
  }

  /** Full validation: syntax plus a DNS check on every resolved address. */
  async validate(raw: string): Promise<ValidatedUrl> {
    const url = this.validateSyntax(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");

    if (isIP(host) !== 0) {
      // A literal address was already checked syntactically.
      return { url, addresses: [host] };
    }

    const addresses = await this.resolve(host);
    if (addresses.length === 0) {
      throw new UrlValidationError(`Host "${host}" did not resolve to any address`, raw);
    }
    if (!this.opts.allowPrivate) {
      for (const address of addresses) {
        if (isBlockedAddress(address)) {
          throw new UrlValidationError(
            `Host "${host}" resolves to non-routable address ${address}`,
            raw,
          );
        }
      }
    }
    return { url, addresses };
  }

  private async resolve(hostname: string): Promise<string[]> {
    if (this.opts.resolve) return this.opts.resolve(hostname);
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((r) => r.address);
  }
}

/**
 * True for loopback, link-local, private, CGNAT, and other non-routable ranges.
 *
 * Addresses are parsed numerically, never compared as strings. That matters:
 * the URL parser normalises alternate IPv4 encodings (`2130706433`,
 * `0x7f000001`, `017700000001`, `127.1`) to dotted-quad *before* we see them,
 * but it rewrites IPv4-mapped IPv6 to the hex form `::ffff:7f00:1`. A
 * dotted-quad regex would therefore miss `http://[::ffff:127.0.0.1]/`, so the
 * embedded IPv4 is extracted from the 128-bit value instead.
 *
 * Unknown forms fail closed.
 */
export function isBlockedAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").split("%")[0]!; // strip IPv6 zone id

  if (isIP(bare) === 4) return isBlockedIPv4(bare);
  if (isIP(bare) === 6) return isBlockedIPv6(bare);

  // A dotted quad that the parser rejected (e.g. "999.1.1.1") is not a valid
  // address; fail closed rather than treat it as a hostname.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) return true;

  const lowered = bare.toLowerCase();
  return lowered === "localhost" || lowered.endsWith(".localhost");
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable: fail closed
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Expand an IPv6 literal to its eight 16-bit groups, or null if unparseable. */
function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase();

  // Fold a trailing dotted quad into two hex groups so the rest of the parser
  // only deals with hex. Handles both "::ffff:127.0.0.1" and "1:2:3:4:5:6:127.0.0.1".
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[2]!.split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${dotted[1]}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const chunk of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      groups.push(parseInt(chunk, 16));
    }
    return groups;
  };

  const left = parse(halves[0] ?? "");
  if (left === null) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;

  const right = parse(halves[1] ?? "");
  if (right === null) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null; // "::" must stand for at least one zero group
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIPv6(address: string): boolean {
  const groups = expandIPv6(address);
  if (!groups) return true; // unparseable: fail closed

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;

  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

  // IPv4-mapped ::ffff:0:0/96 — the embedded IPv4 decides.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIPv4(groupsToIPv4(groups));
  }
  // IPv4-compatible ::/96 (deprecated but still routable as IPv4). `::` and
  // `::1` were handled above, so any remaining zero-prefixed form is judged by
  // its embedded IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIPv4(groupsToIPv4(groups));
  }
  // NAT64 64:ff9b::/96 — translates to the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIPv4(groupsToIPv4(groups));
  }
  // 6to4 2002:AABB:CCDD::/48 embeds the IPv4 in groups 1-2.
  if (g0 === 0x2002) {
    return isBlockedIPv4(groupsToIPv4(groups.slice(1, 3)));
  }

  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** Take the last four 16-bit groups as a dotted quad. */
function groupsToIPv4(groups: number[]): string {
  const last = groups.slice(-2);
  const high = last[0] ?? 0;
  const low = last[1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
