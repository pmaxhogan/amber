/**
 * Per-IP token bucket for failed basic auth attempts on /git/*.
 *
 * In memory on purpose: Amber is a single process, and a restart clearing the
 * counters is not a meaningful weakening given scrypt already makes each guess
 * expensive. The bucket exists to stop a loop from pinning a CPU core on
 * key derivations, not to be a distributed rate limiter.
 */

export interface AuthThrottleOptions {
  /** Failures allowed in a burst. */
  capacity?: number;
  /** Milliseconds to earn one token back. */
  refillMs?: number;
  /** Ceiling on tracked addresses, so the map cannot grow without bound. */
  maxEntries?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export const DEFAULT_THROTTLE_CAPACITY = 10;
export const DEFAULT_THROTTLE_REFILL_MS = 15_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class AuthThrottle {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refillMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: AuthThrottleOptions = {}) {
    this.#capacity = options.capacity ?? DEFAULT_THROTTLE_CAPACITY;
    this.#refillMs = options.refillMs ?? DEFAULT_THROTTLE_REFILL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
  }

  #bucket(key: string): Bucket {
    const now = this.#now();
    const existing = this.#buckets.get(key);
    if (existing === undefined) {
      const fresh: Bucket = { tokens: this.#capacity, updatedAt: now };
      if (this.#buckets.size >= this.#maxEntries) {
        // Oldest insertion first: Map preserves insertion order.
        const oldest = this.#buckets.keys().next();
        if (!oldest.done) {
          this.#buckets.delete(oldest.value);
        }
      }
      this.#buckets.set(key, fresh);
      return fresh;
    }
    const earned = Math.floor((now - existing.updatedAt) / this.#refillMs);
    if (earned > 0) {
      existing.tokens = Math.min(this.#capacity, existing.tokens + earned);
      existing.updatedAt = now;
    }
    return existing;
  }

  /** True when the caller still has budget to attempt an authentication. */
  allow(key: string): boolean {
    return this.#bucket(key).tokens > 0;
  }

  /** Spend a token. Called only when an attempt actually failed. */
  recordFailure(key: string): void {
    const bucket = this.#bucket(key);
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  /** A successful authentication clears the address. */
  recordSuccess(key: string): void {
    this.#buckets.delete(key);
  }

  /** Seconds until the caller earns a token back, for Retry-After. */
  retryAfterSeconds(key: string): number {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.tokens > 0) {
      return 0;
    }
    const elapsed = this.#now() - bucket.updatedAt;
    return Math.max(1, Math.ceil((this.#refillMs - elapsed) / 1000));
  }

  get size(): number {
    return this.#buckets.size;
  }

  clear(): void {
    this.#buckets.clear();
  }
}
