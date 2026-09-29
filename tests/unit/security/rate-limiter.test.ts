import { describe, expect, it } from "vitest";
import {
  KeyedRateLimiter,
  RateLimiter,
} from "../../../src/security/RateLimiter.js";

/** A controllable clock so refill is exact rather than a flaky sleep. */
function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("RateLimiter", () => {
  it("starts full and allows a burst up to capacity", () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: c.now });
    expect(rl.tryAcquire().allowed).toBe(true);
    expect(rl.tryAcquire().allowed).toBe(true);
    const third = rl.tryAcquire();
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it("denies once the bucket is empty and reports a retry delay", () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: c.now });
    rl.tryAcquire();
    rl.tryAcquire();
    const denied = rl.tryAcquire();
    expect(denied.allowed).toBe(false);
    // one token per second → 1000 ms for the next whole token
    expect(denied.retryAfterMs).toBe(1000);
  });

  it("refills over time", () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: c.now });
    rl.tryAcquire();
    rl.tryAcquire();
    expect(rl.tryAcquire().allowed).toBe(false);
    c.advance(1000);
    expect(rl.tryAcquire().allowed).toBe(true);
  });

  it("never exceeds capacity after a long idle period", () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 10, now: c.now });
    rl.tryAcquire();
    rl.tryAcquire();
    c.advance(60_000);
    expect(rl.available()).toBe(2);
  });

  it("can start empty", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1, startFull: false });
    expect(rl.tryAcquire().allowed).toBe(false);
  });

  it("rejects non-positive configuration", () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow();
    expect(() => new RateLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow();
  });
});

describe("KeyedRateLimiter", () => {
  it("keeps an independent bucket per key", () => {
    const k = new KeyedRateLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(k.tryAcquire("web_fetch").allowed).toBe(true);
    expect(k.tryAcquire("web_fetch").allowed).toBe(false);
    // A different tool is unaffected by the first tool's empty bucket.
    expect(k.tryAcquire("web_search").allowed).toBe(true);
  });
});
