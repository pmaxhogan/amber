import { BlockList, isIP } from "node:net";

/**
 * Which peers may tell Amber the client's address through X-Forwarded-For.
 *
 * An explicit allow list (`TRUSTED_PROXY_CIDRS`), default loopback only. A
 * blanket "any private address" rule would let every LAN client (and, behind
 * docker's bridge NAT, often everyone) write its own request.ip, and the git
 * throttle keys on that address. Only a listed peer is believed, and only for
 * ONE hop: request.ip becomes the right-most X-Forwarded-For entry, the one
 * that proxy appended itself, never the client-written ones before it.
 */

/** One CIDR or bare address, as configured. */
export interface ProxyRange {
  address: string;
  prefix: number;
  family: 4 | 6;
}

export const DEFAULT_TRUSTED_PROXY_CIDRS = "127.0.0.0/8,::1";

/** Parse one entry; null when it is not a valid address or CIDR. */
export function parseProxyRange(entry: string): ProxyRange | null {
  const text = entry.trim();
  const slash = text.indexOf("/");
  const address = slash === -1 ? text : text.slice(0, slash);
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    return null;
  }
  const max = family === 4 ? 32 : 128;
  let prefix = max;
  if (slash !== -1) {
    const raw = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) {
      return null;
    }
    prefix = Number(raw);
    if (prefix > max) {
      return null;
    }
  }
  return { address, prefix, family };
}

/** An IPv4-mapped IPv6 peer ("::ffff:10.0.0.1") is judged as the IPv4 address. */
function unmapped(address: string): string {
  const lowered = address.toLowerCase();
  if (lowered.startsWith("::ffff:") && isIP(lowered.slice(7)) === 4) {
    return lowered.slice(7);
  }
  return lowered;
}

/**
 * The Fastify `trustProxy` function for a list of ranges: true only for hop 0
 * (the socket peer) when that peer is in the list. A function rather than a
 * hop count, because Fastify 5 treats a numeric `trustProxy` as trust nothing.
 */
export function proxyTrustFunction(
  ranges: readonly ProxyRange[],
): (address: string, hop: number) => boolean {
  const list = new BlockList();
  for (const range of ranges) {
    list.addSubnet(range.address, range.prefix, range.family === 4 ? "ipv4" : "ipv6");
  }
  return (address, hop) => {
    if (hop !== 0) {
      return false;
    }
    const peer = unmapped(address);
    const family = isIP(peer);
    if (family !== 4 && family !== 6) {
      return false;
    }
    return list.check(peer, family === 4 ? "ipv4" : "ipv6");
  };
}
