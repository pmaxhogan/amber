import { afterEach, beforeEach } from "vitest";
import { setDefaultResolver, type HostResolver } from "../../src/security/egress.ts";

/**
 * DNS fixtures for the egress guard. The public addresses are data only:
 * nothing in the suite ever connects to them (git is pinned to loopback test
 * servers or refused, and provider calls go through an injected transport).
 * RFC 5737 / RFC 3849 documentation addresses cannot stand in for "public"
 * here, because the guard classifies them as NOT public, as it must.
 */
export const PUBLIC_V4 = "93.184.215.14";
export const PUBLIC_V4_B = "93.184.215.15";
export const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";

/** The suite-wide default (test/setup/noRealDns.ts): every lookup throws. */
export const refuseAllDns: HostResolver = (host) => {
  throw new Error(`real DNS is disabled in tests (asked to resolve ${host})`);
};

/** A resolver answering from a table, `fallback` for any other name. */
export function fakeDns(
  table: Readonly<Record<string, readonly string[]>>,
  fallback: readonly string[] = [],
): HostResolver {
  return (host) => Promise.resolve(table[host.toLowerCase()] ?? fallback);
}

/** For a describe block: every name resolves to one public address. */
export function usePublicDns(resolver: HostResolver = fakeDns({}, [PUBLIC_V4])): void {
  beforeEach(() => {
    setDefaultResolver(resolver);
  });
  afterEach(() => {
    setDefaultResolver(refuseAllDns);
  });
}
