import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** Subcommands that talk to a remote. */
export const NETWORK_GIT_COMMANDS: ReadonlySet<string> = new Set([
  "fetch",
  "ls-remote",
  "clone",
  "lfs",
]);

/** The git subcommand of a full argv, skipping `-c key=value` pairs. */
export function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-c") {
      i += 1;
      continue;
    }
    if (!(args[i] ?? "").startsWith("-")) {
      return args[i] ?? "";
    }
  }
  return "";
}

export interface RecordingGit {
  /** Pass as SyncRepoDeps.gitBinary. */
  binary: string;
  /** Every argv git was started with, in order. */
  invocations(): string[][];
  /** Only the ones that would have talked to a remote. */
  networkCalls(): string[][];
  /** Forget what was recorded so far. */
  reset(): void;
}

/**
 * A git wrapper for syncs of restricted forges, which can only ever fetch
 * over http(s) on a standard port and so cannot reach a test origin. Local
 * commands run the real git; anything that would contact a remote is
 * recorded and answered with an empty success, so a sync completes (with
 * nothing fetched) and nothing ever leaves the machine.
 */
export function createRecordingGit(dir: string): RecordingGit {
  const binary = join(dir, "recording-git.mjs");
  const logPath = join(dir, "recording-git.ndjson");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
let sub = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "-c") { i += 1; continue; }
  if (!args[i].startsWith("-")) { sub = args[i]; break; }
}
if (${JSON.stringify([...NETWORK_GIT_COMMANDS])}.includes(sub)) {
  process.exit(0);
}
const result = spawnSync("git", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    "utf8",
  );
  chmodSync(binary, 0o755);
  const invocations = (): string[][] =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as string[])
      : [];
  return {
    binary,
    invocations,
    networkCalls: () =>
      invocations().filter((args) => NETWORK_GIT_COMMANDS.has(gitSubcommand(args))),
    reset: () => {
      rmSync(logPath, { force: true });
    },
  };
}
