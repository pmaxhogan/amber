import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { ForgeProtocol } from "@amber/shared";
import { DomainError } from "../domain/errors.ts";

/**
 * The egress guard for RESTRICTED forges (`forges.allow_private_network = 0`),
 * docs/ARCHITECTURE.md "Forges and outbound requests".
 *
 * Amber's job is fetching URLs people give it, and it is multi-user, so which
 * hosts it will talk to is an access-control decision: a restricted forge may
 * only ever reach PUBLIC addresses. Checking that once, when the forge is
 * created, would be a time-of-check/time-of-use hole (DNS can change later,
 * including deliberate rebinding), so the same check runs before every
 * outbound request and the connection is then PINNED to the address that was
 * validated, so the name is never resolved a second time between check and use.
 *
 * Everything fails closed: an address this module cannot parse is not public,
 * a name that does not resolve is refused, and one non-public answer among
 * several refuses the whole host.
 */

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** Why an address is not public, or "public". */
export type AddressClass =
  | "public"
  | "unspecified"
  | "loopback"
  | "private"
  | "link_local"
  | "cgnat"
  | "unique_local"
  | "multicast"
  | "broadcast"
  | "documentation"
  | "benchmark"
  | "reserved"
  | "ipv4_embedded"
  | "invalid";

interface Range {
  bytes: readonly number[];
  bits: number;
  label: Exclude<AddressClass, "public">;
}

function range(bytes: readonly number[], bits: number, label: Range["label"]): Range {
  return { bytes, bits, label };
}

/**
 * Every IPv4 block that is not globally reachable unicast. Order only
 * matters for which label wins on overlap (255.255.255.255 is broadcast,
 * the rest of 240/4 is reserved).
 */
const V4_NOT_PUBLIC: readonly Range[] = [
  range([0], 8, "unspecified"),
  range([10], 8, "private"),
  range([100, 64], 10, "cgnat"),
  range([127], 8, "loopback"),
  range([169, 254], 16, "link_local"),
  range([172, 16], 12, "private"),
  range([192, 0, 0], 24, "reserved"),
  range([192, 0, 2], 24, "documentation"),
  range([192, 88, 99], 24, "reserved"),
  range([192, 168], 16, "private"),
  range([198, 18], 15, "benchmark"),
  range([198, 51, 100], 24, "documentation"),
  range([203, 0, 113], 24, "documentation"),
  range([224], 4, "multicast"),
  range([255, 255, 255, 255], 32, "broadcast"),
  range([240], 4, "reserved"),
];

/**
 * IPv6 blocks inside global unicast (2000::/3) that are still not public.
 * Everything OUTSIDE 2000::/3 is refused by default, which is what covers
 * fe80::/10, fc00::/7, ff00::/8, fec0::/10, 100::/64 and whatever IANA
 * assigns there next.
 */
const V6_GLOBAL_NOT_PUBLIC: readonly Range[] = [
  range([0x20, 0x01, 0x0d, 0xb8], 32, "documentation"),
  range([0x3f, 0xff], 20, "documentation"),
  // IETF protocol assignments (ORCHID, AS112, TURN anycast, ...). Teredo
  // (2001::/32) sits inside this block and is handled before it.
  range([0x20, 0x01], 23, "reserved"),
];

function matches(address: readonly number[], candidate: Range): boolean {
  let bits = candidate.bits;
  for (let i = 0; bits > 0; i += 1) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((address[i] ?? 0) & mask) !== ((candidate.bytes[i] ?? 0) & mask)) {
      return false;
    }
    bits -= take;
  }
  return true;
}

/** Strict dotted-quad, exactly what net.isIPv4 accepts. */
function parseIpv4(text: string): number[] | null {
  if (isIP(text) !== 4) {
    return null;
  }
  const parts = text.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

/** 16 bytes, or null. A zone id ("%eth0") is never accepted. */
function parseIpv6(text: string): number[] | null {
  if (text.includes("%") || isIP(text) !== 6) {
    return null;
  }
  let head = text;
  let tail4: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (v4 === null) {
      return null;
    }
    tail4 = v4;
    // Keep both colons when the IPv4 tail followed "::" (so "::1.2.3.4" still
    // splits into an empty head and tail), otherwise drop the separator.
    head = text.slice(0, lastColon + 1);
    if (!head.endsWith("::")) {
      head = head.slice(0, -1);
    }
  }
  const groupsWanted = tail4.length === 4 ? 6 : 8;
  const halves = head.split("::");
  if (halves.length > 2) {
    return null;
  }
  const toGroups = (part: string | undefined): number[] =>
    part === undefined || part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  let groups: number[];
  if (halves.length === 2) {
    const fill = groupsWanted - left.length - right.length;
    if (fill < 0) {
      return null;
    }
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== groupsWanted || groups.some((g) => !Number.isInteger(g) || g < 0)) {
    return null;
  }
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  bytes.push(...tail4);
  return bytes.length === 16 ? bytes : null;
}

function classifyIpv4Bytes(bytes: readonly number[]): AddressClass {
  for (const candidate of V4_NOT_PUBLIC) {
    if (matches(bytes, candidate)) {
      return candidate.label;
    }
  }
  return "public";
}

/** The worse of two answers: anything not public wins. */
function worst(a: AddressClass, b: AddressClass): AddressClass {
  return a === "public" ? b : a;
}

function classifyIpv6Bytes(bytes: readonly number[]): AddressClass {
  const zeroPrefix = (count: number): boolean => bytes.slice(0, count).every((b) => b === 0);

  if (bytes.every((b) => b === 0)) {
    return "unspecified";
  }
  if (zeroPrefix(15) && bytes[15] === 1) {
    return "loopback";
  }
  // IPv4-mapped (::ffff:0:0/96), IPv4-translated (::ffff:0:0:0/96) and the
  // deprecated IPv4-compatible form (::/96). No real DNS answer for a forge is
  // one of these, and some stacks route them to the embedded IPv4 address, so
  // they are refused whatever they embed.
  if (
    zeroPrefix(12) ||
    (zeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) ||
    (zeroPrefix(8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0)
  ) {
    return "ipv4_embedded";
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): what DNS64 hands an
  // IPv6-only host for every IPv4 name, so judge the IPv4 address inside it.
  if (matches(bytes, range([0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96, "reserved"))) {
    const inner = classifyIpv4Bytes(bytes.slice(12, 16));
    return inner === "public" ? "public" : "ipv4_embedded";
  }
  // Local-use NAT64 (RFC 8215) can embed IPv4 at several offsets. Refused.
  if (matches(bytes, range([0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48, "reserved"))) {
    return "ipv4_embedded";
  }
  // 6to4 (2002::/16): the IPv4 relay address is bytes 2..5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const inner = classifyIpv4Bytes(bytes.slice(2, 6));
    return inner === "public" ? "public" : "ipv4_embedded";
  }
  // Teredo (2001::/32): server IPv4 in bytes 4..7, client IPv4 obfuscated
  // (XOR 0xff) in bytes 12..15. Both must be public.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    const server = classifyIpv4Bytes(bytes.slice(4, 8));
    const client = classifyIpv4Bytes(bytes.slice(12, 16).map((b) => b ^ 0xff));
    return worst(server, client) === "public" ? "public" : "ipv4_embedded";
  }
  if (bytes[0] === 0xff) {
    return "multicast";
  }
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) {
    return "link_local";
  }
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) {
    return "unique_local";
  }
  // Global unicast is 2000::/3; everything else is reserved or special.
  if (((bytes[0] ?? 0) & 0xe0) !== 0x20) {
    return "reserved";
  }
  for (const candidate of V6_GLOBAL_NOT_PUBLIC) {
    if (matches(bytes, candidate)) {
      return candidate.label;
    }
  }
  return "public";
}

/**
 * Classify one numeric address as a resolver returns it (dotted IPv4, or
 * IPv6 in any textual form). Anything unparseable is "invalid", which is not
 * public.
 */
export function classifyAddress(address: string): AddressClass {
  const text = address.trim();
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const v4 = parseIpv4(bare);
  if (v4 !== null) {
    return classifyIpv4Bytes(v4);
  }
  const v6 = parseIpv6(bare.toLowerCase());
  if (v6 !== null) {
    return classifyIpv6Bytes(v6);
  }
  return "invalid";
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === "public";
}

// ---------------------------------------------------------------------------
// Host names
// ---------------------------------------------------------------------------

/** One LDH label (RFC 1123), so punycode IDNs pass and nothing else does. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * True when `host` is, or would be parsed by a resolver or URL parser as, an
 * IP address: dotted, bracketed or bare IPv6, and the integer, octal, hex and
 * short-dotted IPv4 forms (`2130706433`, `0x7f000001`, `0177.0.0.1`,
 * `127.1`). The WHATWG URL rule is that a host whose last label is a number
 * is an IPv4 address, so any such host is treated as a literal.
 */
export function isIpLiteralHost(host: string): boolean {
  const lowered = host.trim().toLowerCase();
  if (lowered.startsWith("[") || lowered.includes(":")) {
    return true;
  }
  if (isIP(lowered) !== 0) {
    return true;
  }
  const labels = lowered.replace(/\.$/, "").split(".");
  const last = labels[labels.length - 1] ?? "";
  if (/^(?:0x[0-9a-f]*|[0-9]+)$/.test(last)) {
    return true;
  }
  try {
    const parsed = new URL(`http://${lowered}/`).hostname;
    if (isIP(parsed.replace(/^\[|\]$/g, "")) !== 0) {
      return true;
    }
  } catch {
    // Not a parseable host at all; the hostname check refuses it.
  }
  return false;
}

/**
 * A restricted forge must be named by an ordinary public DNS name: LDH
 * labels, at least two of them (a single label is an intranet name), at most
 * 253 characters, and unchanged by the URL parser.
 */
export function isAcceptableHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253 || host !== host.toLowerCase()) {
    return false;
  }
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return false;
  }
  try {
    return new URL(`http://${host}/`).hostname === host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type EgressRefusalReason =
  "scheme" | "port" | "ip_literal" | "invalid_host" | "not_public" | "unresolvable";

const PRIVATE_HINT = "Only the admin can allow a forge to reach private networks.";

function messageFor(reason: EgressRefusalReason, host: string): string {
  switch (reason) {
    case "scheme":
      return "A restricted forge must use https or http.";
    case "port":
      return "A restricted forge must use the standard port: https on 443 or http on 80.";
    case "ip_literal":
      return "A restricted forge must be named by a DNS host name, not an IP address.";
    case "invalid_host":
      return `${host} is not a public DNS host name.`;
    case "not_public":
      return `${host} resolves to an address that is not public. ${PRIVATE_HINT}`;
    case "unresolvable":
      return `${host} does not resolve.`;
  }
}

/**
 * A refusal. The message names the host (which the caller supplied) and the
 * reason category, never a resolved address: a non-admin must not be able
 * to map the internal network through error messages. `addresses` is for
 * the server log only.
 */
export class EgressRefusedError extends DomainError {
  readonly reason: EgressRefusalReason;
  readonly host: string;
  /** Resolved addresses and their classes, for logs. Never sent to a client. */
  readonly addresses: readonly { address: string; class: AddressClass }[];

  constructor(
    reason: EgressRefusalReason,
    host: string,
    addresses: readonly { address: string; class: AddressClass }[] = [],
  ) {
    super("host_not_allowed", messageFor(reason, host), { reason });
    this.reason = reason;
    this.host = host;
    this.addresses = addresses;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Every address a name resolves to (A and AAAA). Empty means "does not resolve". */
export type HostResolver = (host: string) => Promise<readonly string[]>;

export const RESOLVE_TIMEOUT_MS = 10_000;

/**
 * getaddrinfo through dns.lookup, the same resolver git's libcurl and Node's
 * sockets use, so /etc/hosts and the container's search domains are judged
 * too. Bounded, because dns.lookup has no timeout of its own.
 */
export const systemResolver: HostResolver = async (host) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const answers = await Promise.race([
      dnsLookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("dns lookup timed out"));
        }, RESOLVE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return answers.map((answer) => answer.address);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

let resolverOverride: HostResolver | undefined;

/**
 * TEST SEAM. Replace the default resolver for this process, or restore it
 * with undefined. The server test setup installs one that refuses every
 * name, so no test can depend on real DNS by accident.
 */
export function setDefaultResolver(resolver: HostResolver | undefined): void {
  resolverOverride = resolver;
}

export function defaultResolver(): HostResolver {
  return resolverOverride ?? systemResolver;
}

// ---------------------------------------------------------------------------
// The one check: creation and every request
// ---------------------------------------------------------------------------

export interface EgressTarget {
  protocol: ForgeProtocol | string;
  host: string;
  /** null means the protocol's default. */
  port: number | null;
}

/** A host:port that passed the check, and the addresses it may be reached at. */
export interface VettedTarget {
  protocol: "https" | "http";
  host: string;
  port: number;
  /** Every validated answer, all public. Never empty. */
  addresses: readonly string[];
}

function effectivePort(protocol: string, port: number | null): number | null {
  if (protocol === "https") {
    return port ?? 443;
  }
  if (protocol === "http") {
    return port ?? 80;
  }
  return null;
}

/**
 * THE RULE for a restricted forge, used identically when the forge is created
 * and before every outbound request: plain https on 443 or http on 80, a DNS
 * host name (never an IP literal), and every address the name resolves to is
 * public. Returns the validated addresses so the caller can pin to them, and
 * throws EgressRefusedError otherwise.
 */
export async function vetRestrictedTarget(
  target: EgressTarget,
  resolver: HostResolver = defaultResolver(),
): Promise<VettedTarget> {
  const protocol = target.protocol.toLowerCase();
  const host = target.host.trim().toLowerCase();
  if (protocol !== "https" && protocol !== "http") {
    throw new EgressRefusedError("scheme", host);
  }
  const port = effectivePort(protocol, target.port);
  if (port !== (protocol === "https" ? 443 : 80)) {
    throw new EgressRefusedError("port", host);
  }
  if (isIpLiteralHost(host)) {
    throw new EgressRefusedError("ip_literal", host);
  }
  if (!isAcceptableHostname(host)) {
    throw new EgressRefusedError("invalid_host", host);
  }

  const answers = [...new Set(await resolver(host))];
  if (answers.length === 0) {
    throw new EgressRefusedError("unresolvable", host);
  }
  const judged = answers.map((address) => ({ address, class: classifyAddress(address) }));
  // One bad answer refuses the host: a client may connect to any of them, and
  // "mostly public" is how a rebinding attack would look.
  if (judged.some((answer) => answer.class !== "public")) {
    throw new EgressRefusedError("not_public", host, judged);
  }
  return { protocol, host, port, addresses: answers };
}

/** The same check for a URL, as provider calls and redirects hand them over. */
export async function vetRestrictedUrl(
  url: string,
  resolver: HostResolver = defaultResolver(),
): Promise<VettedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressRefusedError("invalid_host", "");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    // Never a credential in a URL; refusing here also keeps it out of errors.
    throw new EgressRefusedError("invalid_host", parsed.hostname);
  }
  const protocol = parsed.protocol.replace(/:$/, "");
  return vetRestrictedTarget(
    {
      protocol,
      host: parsed.hostname,
      port: parsed.port === "" ? null : Number(parsed.port),
    },
    resolver,
  );
}

// ---------------------------------------------------------------------------
// Pinning: git
// ---------------------------------------------------------------------------

/** Bracket an IPv6 address the way CURLOPT_RESOLVE wants it. */
function curlAddress(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

/**
 * `-c` entries, in order, that pin a git invocation to the validated
 * addresses (git >= 2.37, http.curloptResolve = libcurl CURLOPT_RESOLVE):
 *
 * - an EMPTY value first resets any resolve entries from other config
 *   sources (repository config included), so ours are the only ones;
 * - `HOST:PORT:ADDR[,ADDR]` then makes libcurl use exactly those addresses
 *   for that host and port and never resolve the name itself;
 * - `http.followRedirects=false`, because the default `initial` follows a
 *   redirect on the first request to ANY host, and that host would be
 *   resolved by libcurl, unvalidated and unpinned. A restricted forge's
 *   redirects (renamed repos included) therefore fail the fetch. The one
 *   exception is the well-known public tier (`followRedirects: true`), which
 *   keeps git's default `initial` so renamed repositories keep working;
 * - `transfer.bundleURI=false`, so a server cannot point a clone at bundles
 *   on another host. (Packfile URIs need `fetch.uriProtocols`, which is
 *   unset and cannot be set by a repository.)
 *
 * Nothing in these values can carry a credential: they hold the host, the
 * port and numeric addresses only.
 */
export function gitPinConfig(
  vetted: VettedTarget,
  options: { followRedirects?: boolean } = {},
): [string, string][] {
  return [
    ["http.curloptResolve", ""],
    [
      "http.curloptResolve",
      `${vetted.host}:${String(vetted.port)}:${vetted.addresses.map(curlAddress).join(",")}`,
    ],
    ["http.followRedirects", options.followRedirects === true ? "initial" : "false"],
    ["transfer.bundleURI", "false"],
  ];
}

// ---------------------------------------------------------------------------
// The well-known public forge tier
// ---------------------------------------------------------------------------

/**
 * Forges everyone knows are public internet services. KEEP IN SYNC with the
 * literal list in db/migrations.ts (010 backfill), which cannot import app
 * code; migration010.test.ts asserts the two match.
 */
export const WELL_KNOWN_PUBLIC_FORGE_HOSTS: readonly string[] = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
];

/**
 * A RESTRICTED forge on this list (https, default port, exact host) keeps the
 * DNS check and the pin, but is allowed two things other restricted forges
 * are not, because the hosts are known public services and refusing them
 * would break real backups: git's default `http.followRedirects=initial`
 * (renamed repositories redirect), and git-lfs, run with its endpoint forced
 * on the command line (lfsEndpointConfig). Everything else restricted gets
 * no redirects and no LFS.
 */
export function isWellKnownPublicForge(target: EgressTarget): boolean {
  const protocol = target.protocol.toLowerCase();
  return (
    protocol === "https" &&
    (target.port === null || target.port === 443) &&
    WELL_KNOWN_PUBLIC_FORGE_HOSTS.includes(target.host.trim().toLowerCase())
  );
}

/**
 * The git-lfs endpoint for a clone URL, derived the way git-lfs derives it
 * itself (`<remote>.git/info/lfs`), forced with `-c lfs.url=`. Git config
 * (command line included) outranks a repository's `.lfsconfig`, and `lfs.url`
 * outranks `remote.<name>.lfsurl` (git-lfs-config(5); lfsapi endpoint
 * finder), so a hostile repository cannot point git-lfs at another server.
 * The batch API's object download URLs are still the forge's to choose; that
 * is accepted for this tier only.
 */
export function lfsEndpointConfig(remoteUrl: string): [string, string][] {
  const base = remoteUrl.replace(/\/+$/, "");
  const endpoint = /\.git$/i.test(base) ? `${base}/info/lfs` : `${base}.git/info/lfs`;
  return [["lfs.url", endpoint]];
}

// ---------------------------------------------------------------------------
// Pinning: provider HTTP
// ---------------------------------------------------------------------------

/**
 * A socket `lookup` that answers only for `pin.host`, and only with the
 * validated addresses. Anything else fails as "not found", so a connection
 * can never be steered to an address the guard did not check. For
 * node:http(s) requests and agents (pinnedFetch here, web push in
 * notify/push.ts).
 */
export function pinnedLookup(pin: VettedTarget): LookupFunction {
  return (hostname, options, callback) => {
    const first = pin.addresses[0];
    if (hostname.toLowerCase() !== pin.host || first === undefined) {
      const error = Object.assign(new Error(`refusing to resolve ${hostname}`), {
        code: "ENOTFOUND",
      });
      callback(error, "", 0);
      return;
    }
    const all = pin.addresses.map((address) => ({ address, family: isIP(address) }));
    if (options.all === true) {
      (callback as unknown as (err: null, list: typeof all) => void)(null, all);
      return;
    }
    callback(null, first, isIP(first));
  };
}

/**
 * An https.Agent pinned like pinnedLookup, for clients that only accept an
 * agent (web-push). TLS still verifies the certificate against the request's
 * host name; only the address lookup is replaced. No keep-alive, so the
 * caller destroys it after one request and nothing outlives the pin.
 */
export function pinnedHttpsAgent(pin: VettedTarget): https.Agent {
  return new https.Agent({ lookup: pinnedLookup(pin), keepAlive: false });
}

/** Same shape as the providers' fetch, plus the target it must be pinned to. */
export type PinnedFetch = (url: string, init: RequestInit, pin: VettedTarget) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function toHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  return headers;
}

function requestHeaders(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/**
 * A fetch whose connection is pinned to `pin.addresses`. node:http(s) with a
 * custom `lookup`, so:
 * - the socket connects only to an address that was validated, and the name
 *   is never handed to a resolver again;
 * - TLS still verifies the certificate against the HOST NAME (the request
 *   names the host; only the address lookup is replaced), with SNI set to it;
 * - no connection pooling (`agent: false`), so a socket opened under one pin
 *   is never reused under another;
 * - redirects are not followed here: the caller sees the 3xx and re-vets.
 */
export const pinnedFetch: PinnedFetch = async (url, init, pin) => {
  const target = new URL(url);
  const protocol = target.protocol.replace(/:$/, "");
  const port = effectivePort(protocol, target.port === "" ? null : Number(target.port));
  if (target.hostname !== pin.host || port !== pin.port || protocol !== pin.protocol) {
    throw new EgressRefusedError("invalid_host", target.hostname);
  }
  const first = pin.addresses[0];
  if (first === undefined) {
    throw new EgressRefusedError("unresolvable", pin.host);
  }

  const lookup = pinnedLookup(pin);

  const transport = protocol === "https" ? https : http;
  const signal = init.signal ?? undefined;

  return await new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: init.method ?? "GET",
        headers: requestHeaders(init),
        lookup,
        agent: false,
        ...(signal === undefined || signal === null ? {} : { signal }),
      },
      (message) => {
        const status = message.statusCode ?? 0;
        if (status < 200 || status > 599) {
          message.destroy();
          reject(new Error(`unexpected HTTP status ${String(status)}`));
          return;
        }
        const body = NULL_BODY_STATUSES.has(status)
          ? null
          : (Readable.toWeb(message) as ReadableStream<Uint8Array>);
        if (body === null) {
          message.resume();
        }
        resolve(new Response(body, { status, headers: toHeaders(message) }));
      },
    );
    request.on("error", (error) => {
      // An abort surfaces as a generic AbortError; hand back the signal's own
      // reason so a timeout is still recognisable as a TimeoutError.
      reject(signal?.aborted === true ? (signal.reason as Error) : error);
    });
    request.end();
  });
};
