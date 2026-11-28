/**
 * Token buckets for failed basic auth attempts on /git/*.
 *
 * In memory on purpose: Amber is a single process, and a restart clearing the
 * counters is not a meaningful weakening given scrypt already makes each guess
 * expensive. The buckets exist to stop a loop from pinning a CPU core on key
 * derivations and to slow guessing, not to be a distributed rate limiter.
 *
 * Two kinds of bucket, both spent by every failure:
 *
 * - PER ADDRESS, the CPU guard. It is never cleared by a success: if it were,
 *   anyone holding one valid credential could interleave a good login between
 *   guesses at other usernames and never run dry.
 * - PER (address, username). A success clears only that pair and remembers it
 *   as KNOWN GOOD for a while. A known-good pair is let through an exhausted
 *   address bucket (its own pair bucket still applies), so a client spraying
 *   guesses from an address another user also logs in from (a shared NAT, an
 *   office) cannot lock that user out of their own known address.
 *
 * Every map is bounded: the oldest insertion is evicted first.
 */

import { isIP } from "node:net";

export interface AuthThrottleOptions {
  /** Failures allowed in a burst, per (address, username). */
  capacity?: number;
  /** Failures allowed in a burst, per address. Defaults to a few pairs' worth. */
  addressCapacity?: number;
  /** Milliseconds to earn one token back. */
  refillMs?: number;
  /** Ceiling on tracked buckets and on known-good pairs, each. */
  maxEntries?: number;
  /** How long a successful (address, username) stays known good. */
  knownGoodMs?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export const DEFAULT_THROTTLE_CAPACITY = 10;
export const DEFAULT_THROTTLE_ADDRESS_CAPACITY = 30;
export const DEFAULT_THROTTLE_REFILL_MS = 15_000;
export const DEFAULT_KNOWN_GOOD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * The address a bucket is keyed on. An IPv6 client is aggregated to its /64:
 * a single host is routinely handed a whole /64 and can pick a fresh address
 * from it for every attempt, which would otherwise be a fresh bucket each
 * time. An IPv4-mapped IPv6 address is keyed as the IPv4 address it carries.
 * Anything unparseable is keyed as written.
 */
export function addressKey(ip: string): string {
  const bare = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (isIP(bare) !== 6) {
    return bare;
  }
  if (bare.startsWith("::ffff:") && isIP(bare.slice(7)) === 4) {
    return bare.slice(7);
  }
  const groups = expandIpv6(bare);
  return groups === null ? bare : `${groups.slice(0, 4).join(":")}::/64`;
}

/** Eight 16-bit groups as lower-case hex without leading zeros, or null. */
function expandIpv6(text: string): string[] | null {
  let head = text;
  let tail: string[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (isIP(maybeV4) === 4) {
    const [a, b, c, d] = maybeV4.split(".").map(Number) as [number, number, number, number];
    tail = [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    head = text.slice(0, lastColon + 1);
    if (!head.endsWith("::")) {
      head = head.slice(0, -1);
    }
  }
  const halves = head.split("::");
  if (halves.length > 2) {
    return null;
  }
  const split = (part: string | undefined): string[] =>
    part === undefined || part === "" ? [] : part.split(":");
  const left = split(halves[0]);
  const right = [...split(halves[1]), ...tail];
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) {
    return null;
  }
  const groups = [
    ...left,
    ...new Array<string>(halves.length === 2 ? fill : 0).fill("0"),
    ...right,
  ];
  return groups.length === 8
    ? groups.map((group) => Number.parseInt(group, 16).toString(16))
    : null;
}

/**
 * The pair key. A username is client-chosen text, so it is capped: the slug
 * format is 10 characters, and anything far longer cannot be a real one.
 * NUL never appears in an address, so the two parts cannot run together.
 */
export function pairKey(ip: string, username: string): string {
  return `${addressKey(ip)}\u0000${username.slice(0, 64)}`;
}

function insertBounded<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  if (!map.has(key) && map.size >= max) {
    // Oldest insertion first: Map preserves insertion order.
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

export class AuthThrottle {
  readonly #buckets = new Map<string, Bucket>();
  readonly #knownGood = new Map<string, number>();
  readonly #capacity: number;
  readonly #addressCapacity: number;
  readonly #refillMs: number;
  readonly #maxEntries: number;
  readonly #knownGoodMs: number;
  readonly #now: () => number;

  constructor(options: AuthThrottleOptions = {}) {
    this.#capacity = options.capacity ?? DEFAULT_THROTTLE_CAPACITY;
    this.#addressCapacity =
      options.addressCapacity ??
      (options.capacity === undefined
        ? DEFAULT_THROTTLE_ADDRESS_CAPACITY
        : options.capacity * (DEFAULT_THROTTLE_ADDRESS_CAPACITY / DEFAULT_THROTTLE_CAPACITY));
    this.#refillMs = options.refillMs ?? DEFAULT_THROTTLE_REFILL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#knownGoodMs = options.knownGoodMs ?? DEFAULT_KNOWN_GOOD_MS;
    this.#now = options.now ?? Date.now;
  }

  #bucket(key: string, capacity: number): Bucket {
    const now = this.#now();
    const existing = this.#buckets.get(key);
    if (existing === undefined) {
      const fresh: Bucket = { tokens: capacity, updatedAt: now };
      insertBounded(this.#buckets, key, fresh, this.#maxEntries);
      return fresh;
    }
    const earned = Math.floor((now - existing.updatedAt) / this.#refillMs);
    if (earned > 0) {
      existing.tokens = Math.min(capacity, existing.tokens + earned);
      existing.updatedAt = now;
    }
    return existing;
  }

  #peek(key: string, capacity: number): boolean {
    return this.#buckets.has(key) ? this.#bucket(key, capacity).tokens > 0 : true;
  }

  #isKnownGood(pair: string): boolean {
    const at = this.#knownGood.get(pair);
    if (at === undefined) {
      return false;
    }
    if (this.#now() - at > this.#knownGoodMs) {
      this.#knownGood.delete(pair);
      return false;
    }
    return true;
  }

  /** True while the address bucket alone still has budget. */
  allowAddress(ip: string): boolean {
    return this.#peek(addressKey(ip), this.#addressCapacity);
  }

  /**
   * True when an attempt for `username` from `ip` may run: its own pair
   * bucket has budget, and either the address bucket does or the pair is
   * known good.
   */
  allow(ip: string, username: string): boolean {
    const pair = pairKey(ip, username);
    if (!this.#peek(pair, this.#capacity)) {
      return false;
    }
    return this.allowAddress(ip) || this.#isKnownGood(pair);
  }

  /** Spend a token from both buckets. Called only when an attempt actually failed. */
  recordFailure(ip: string, username: string): void {
    const address = this.#bucket(addressKey(ip), this.#addressCapacity);
    address.tokens = Math.max(0, address.tokens - 1);
    const pair = this.#bucket(pairKey(ip, username), this.#capacity);
    pair.tokens = Math.max(0, pair.tokens - 1);
  }

  /**
   * A successful authentication clears ONLY its own pair and marks it known
   * good. The address bucket is left alone (see the module comment).
   */
  recordSuccess(ip: string, username: string): void {
    const pair = pairKey(ip, username);
    this.#buckets.delete(pair);
    this.#knownGood.delete(pair);
    insertBounded(this.#knownGood, pair, this.#now(), this.#maxEntries);
  }

  /** Seconds until the attempt would be allowed again, for Retry-After. */
  retryAfterSeconds(ip: string, username?: string): number {
    const waits: number[] = [];
    const address = addressKey(ip);
    for (const key of username === undefined ? [address] : [address, pairKey(ip, username)]) {
      const bucket = this.#buckets.get(key);
      if (bucket === undefined || bucket.tokens > 0) {
        continue;
      }
      const elapsed = this.#now() - bucket.updatedAt;
      waits.push(Math.max(1, Math.ceil((this.#refillMs - elapsed) / 1000)));
    }
    return waits.length === 0 ? 0 : Math.max(...waits);
  }

  /** Tracked buckets (addresses and pairs). */
  get size(): number {
    return this.#buckets.size;
  }

  /** Remembered known-good pairs. */
  get knownGoodSize(): number {
    return this.#knownGood.size;
  }

  clear(): void {
    this.#buckets.clear();
    this.#knownGood.clear();
  }
}
