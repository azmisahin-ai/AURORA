/**
 * Token-bucket rate limiter (Phase 8, ADR 010).
 *
 * The threat is not a malicious user — a local operator can already run any
 * command directly. It is a *loop*: a model that decides to fetch a page, fails
 * to parse it, and fetches it again, sixty times, from one run. A rate limit is
 * how the runtime says "you are looping" in a way the observation channel can
 * carry back to the model.
 *
 * The clock is injected. `Date.now()` in a limiter makes the only interesting
 * test — "a token comes back after the window" — a `sleep`, which is slow and
 * flaky. With a clocked limiter the same test is exact.
 */

export interface RateLimiterOptions {
  /** Bucket capacity: the largest burst allowed. */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSecond: number;
  /** Clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Start full. Defaults to true. */
  startFull?: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left after this decision. */
  remaining: number;
  /** Milliseconds until one token is available. 0 when allowed. */
  retryAfterMs: number;
}

/**
 * A single bucket. Not thread-safe across processes; AURORA is single-process
 * (ADR 008), and the limiter is per-registry, which is per-run.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefill: number;

  constructor(opts: RateLimiterOptions) {
    if (!(opts.capacity > 0)) throw new Error("RateLimiter capacity must be positive");
    if (!(opts.refillPerSecond > 0)) {
      throw new Error("RateLimiter refillPerSecond must be positive");
    }
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSecond / 1000;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.startFull === false ? 0 : opts.capacity;
    this.lastRefill = this.now();
  }

  /** Try to take one token. Does not block: the caller decides what to do. */
  tryAcquire(cost = 1): RateLimitDecision {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: this.tokens, retryAfterMs: 0 };
    }
    const deficit = cost - this.tokens;
    return {
      allowed: false,
      remaining: this.tokens,
      retryAfterMs: Math.ceil(deficit / this.refillPerMs),
    };
  }

  /** Tokens currently available, after refill. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}

/**
 * A set of independent buckets keyed by name (e.g. one per tool). A limiter per
 * tool means a chatty filesystem tool cannot exhaust the budget the network
 * tool depends on.
 */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, RateLimiter>();
  constructor(private readonly options: RateLimiterOptions) {}

  /** Acquire one token for `key`, creating its bucket on first use. */
  tryAcquire(key: string, cost = 1): RateLimitDecision {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new RateLimiter(this.options);
      this.buckets.set(key, bucket);
    }
    return bucket.tryAcquire(cost);
  }
}
