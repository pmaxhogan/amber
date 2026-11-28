import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { assertForgeAllowed } from "../src/domain/forges.ts";
import { lookupRepoInfo } from "../src/providers/forks.ts";
import type { AccountSyncProvider, DiscoveryContext } from "../src/providers/types.ts";
import { listSyncRuns } from "../src/sync/repoStore.ts";
import {
  isGitLfsAvailable,
  resetLfsProbe,
  syncRepo,
  type SyncRepoDeps,
} from "../src/sync/syncRepo.ts";
import {
  createRecordingGit,
  fakeDns,
  gitSubcommand,
  PUBLIC_V4,
  PUBLIC_V6,
  usePublicDns,
  type RecordingGit,
} from "./helpers/egress.ts";
import {
  createTestDb,
  fixedSettings,
  insertForge,
  insertRepo,
  silentLog,
  tempDir,
} from "./helpers/gitFixtures.ts";
import { createTempApp, type TempApp } from "./helpers.ts";
import { asUser } from "./helpers/accessFixtures.ts";
import { adminOf, makeUser } from "./helpers/users.ts";

/**
 * The egress guard where it bites: a sync of a restricted forge (rebinding,
 * the exact git argv, LFS), and forge creation through the real routes and
 * import. git runs through a recording wrapper: local commands go to the real
 * git, and anything that would talk to a remote is written down and answered
 * with an empty success, so nothing in here ever leaves the machine.
 */

const PASSWORD = "tok-very-secret-123";

let root: string;
let db: Db;
let git: RecordingGit;

const subcommand = gitSubcommand;

function invocations(): string[][] {
  return git.invocations();
}

function networkCalls(): string[][] {
  return git.networkCalls();
}

/** The -c values of one invocation, in order. */
function configOf(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-c") {
      out.push(args[i + 1] ?? "");
      i += 1;
    }
  }
  return out;
}

const PIN_ENTRIES = (host: string, addresses: string): string[] => [
  "-c",
  "http.curloptResolve=",
  "-c",
  `http.curloptResolve=${host}:443:${addresses}`,
  "-c",
  "http.followRedirects=false",
  "-c",
  "transfer.bundleURI=false",
];

async function sync(
  repoId: number,
  overrides: Partial<SyncRepoDeps> = {},
): Promise<Awaited<ReturnType<typeof syncRepo>>> {
  return syncRepo({
    repoId,
    db,
    backupsDir: join(root, "backups"),
    stateDir: join(root, "state"),
    logger: silentLog,
    settings: fixedSettings({ lfs_enabled: true }),
    credentials: () => ({ username: "octo", password: PASSWORD }),
    gitBinary: git.binary,
    ...overrides,
  });
}

function repoOn(host: string, restricted: boolean, path = "acme/widgets"): number {
  const forgeId = insertForge(db, { host, allowPrivateNetwork: !restricted });
  return insertRepo(db, { forgeId, path });
}

describe("syncing a restricted forge", () => {
  beforeEach(() => {
    root = tempDir("egress-sync");
    db = createTestDb(root);
    git = createRecordingGit(root);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("pins every network git call to the validated addresses, and never puts the credential in argv", async () => {
    const repoId = repoOn("git.example.com", true);
    const run = await sync(repoId, {
      resolveHost: fakeDns({ "git.example.com": [PUBLIC_V4, PUBLIC_V6] }),
    });
    expect(run.outcome).toBe("success");

    const calls = networkCalls();
    expect(calls.map(subcommand)).toEqual(["ls-remote", "fetch"]);
    for (const args of calls) {
      const config = configOf(args);
      // The pin comes last, after the hardening set, so it wins.
      expect(config.slice(-4)).toEqual([
        "http.curloptResolve=",
        `http.curloptResolve=git.example.com:443:${PUBLIC_V4},[${PUBLIC_V6}]`,
        "http.followRedirects=false",
        "transfer.bundleURI=false",
      ]);
      expect(config.indexOf("http.followRedirects=initial")).toBeLessThan(
        config.indexOf("http.followRedirects=false"),
      );
    }
    // No credential anywhere in any argv, network or not.
    for (const args of invocations()) {
      expect(args.join("\n")).not.toContain(PASSWORD);
      expect(args.join("\n")).not.toMatch(/:\/\/[^/\s]*@/);
    }
  });

  it("leaves an unrestricted forge's argv exactly as it was", async () => {
    const restrictedRepo = repoOn("git.example.com", true);
    await sync(restrictedRepo, { resolveHost: fakeDns({ "git.example.com": [PUBLIC_V4] }) });
    const pinned = networkCalls();
    git.reset();

    const openRepo = repoOn("git.example.org", false);
    await sync(openRepo, {
      resolveHost: () => Promise.reject(new Error("an unrestricted forge must not be resolved")),
    });
    // git-lfs, when installed, runs only for the unrestricted forge (see below).
    const open = networkCalls().filter((args) => subcommand(args) !== "lfs");

    expect(open.map(subcommand)).toEqual(["ls-remote", "fetch"]);
    for (const args of open) {
      expect(configOf(args).some((value) => value.startsWith("http.curloptResolve"))).toBe(false);
      expect(configOf(args)).toContain("http.followRedirects=initial");
      expect(configOf(args)).not.toContain("http.followRedirects=false");
    }
    // Same commands, same flags: the restricted run is the unrestricted run
    // plus the pin entries and nothing else.
    const pinEntries = PIN_ENTRIES("git.example.com", PUBLIC_V4);
    for (const [index, args] of pinned.entries()) {
      const start = args.indexOf("http.curloptResolve=") - 1;
      const stripped = [...args.slice(0, start), ...args.slice(start + pinEntries.length)];
      expect(args.slice(start, start + pinEntries.length)).toEqual(pinEntries);
      expect(stripped).toEqual(open[index]);
    }
  });

  it("refuses at fetch time a host that resolved public at creation and private now", async () => {
    const answers = [[PUBLIC_V4], ["10.9.8.7"]];
    const rebinding = (): Promise<string[]> => Promise.resolve(answers.shift() ?? []);
    const admin = adminOf(db);

    // Creation: public, so the forge is created.
    await assertForgeAllowed(
      { protocol: "https", host: "rebind.example.com", port: null },
      admin,
      { allowPrivateNetwork: false },
      rebinding,
    );
    const repoId = repoOn("rebind.example.com", true);

    // Fetch: the same name now answers privately.
    const run = await sync(repoId, { resolveHost: rebinding });
    expect(run.outcome).toBe("error");
    expect(run.errorKind).toBe("network");
    expect(run.error).toMatch(/rebind\.example\.com resolves to an address that is not public/);
    expect(run.error).not.toContain("10.9.8.7");
    // Refused before git was ever started, and nothing was written to disk.
    expect(invocations()).toEqual([]);
    expect(existsSync(join(root, "backups"))).toBe(false);

    // A normal failure: it backs off like any other, and is not "gone".
    const row = db.get<{
      consecutive_failures: number;
      next_sync_at: number;
      gone_at: number | null;
    }>("SELECT consecutive_failures, next_sync_at, gone_at FROM repos WHERE id = ?", repoId);
    expect(row?.consecutive_failures).toBe(1);
    expect(row?.gone_at).toBeNull();
    expect(row?.next_sync_at).toBeGreaterThan(Date.now());
    expect(listSyncRuns(db, repoId)[0]).toMatchObject({ errorKind: "network" });
  });

  it.each([
    ["a mixed answer", [PUBLIC_V4, "192.168.0.10"]],
    ["no answer at all", []],
    ["a loopback answer", ["127.0.0.1"]],
  ])("refuses %s at fetch time", async (_label, addresses) => {
    const repoId = repoOn("git.example.com", true);
    const run = await sync(repoId, { resolveHost: () => Promise.resolve(addresses) });
    expect(run.outcome).toBe("error");
    expect(run.errorKind).toBe("network");
    expect(invocations()).toEqual([]);
  });

  it("refuses a restricted forge that is not on a standard port, without resolving it", async () => {
    const forgeId = insertForge(db, {
      host: "git.example.com",
      port: 8443,
      allowPrivateNetwork: false,
    });
    const repoId = insertRepo(db, { forgeId, path: "a/b" });
    const run = await sync(repoId, {
      resolveHost: () => Promise.reject(new Error("must not resolve")),
    });
    expect(run.errorKind).toBe("network");
    expect(run.error).toMatch(/standard port/);
    expect(invocations()).toEqual([]);
  });

  it("never runs git-lfs against a restricted forge, which it cannot pin", async () => {
    const repoId = repoOn("git.example.com", true);
    await sync(repoId, { resolveHost: fakeDns({ "git.example.com": [PUBLIC_V4] }) });
    expect(networkCalls().map(subcommand)).not.toContain("lfs");

    // Control: the same settings on an unrestricted forge do reach git-lfs,
    // wherever git-lfs is installed (the probe runs the real binary).
    git.reset();
    resetLfsProbe();
    const lfsInstalled = await isGitLfsAvailable({ stateDir: join(root, "state") });
    await sync(repoOn("git.example.org", false));
    expect(networkCalls().map(subcommand).includes("lfs")).toBe(lfsInstalled);
  });
});

describe("the well-known public forge tier", () => {
  beforeEach(() => {
    root = tempDir("egress-tier");
    db = createTestDb(root);
    git = createRecordingGit(root);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function seededGithubRepo(): number {
    // Seeded by 003 and restricted by the 010 backfill.
    const forge = db.get<{ id: number; allow_private_network: number }>(
      "SELECT id, allow_private_network FROM forges WHERE host = 'github.com'",
    );
    expect(forge?.allow_private_network).toBe(0);
    return insertRepo(db, { forgeId: forge?.id ?? 0, path: "acme/widgets" });
  }

  it("is pinned, keeps git's redirect default, and forces the LFS endpoint", async () => {
    resetLfsProbe();
    const lfsInstalled = await isGitLfsAvailable({ stateDir: join(root, "state") });
    const run = await sync(seededGithubRepo(), {
      resolveHost: fakeDns({ "github.com": [PUBLIC_V4] }),
    });
    expect(run.outcome).toBe("success");

    const calls = networkCalls();
    const git = calls.filter((args) => subcommand(args) !== "lfs");
    expect(git.map(subcommand)).toEqual(["ls-remote", "fetch"]);
    for (const args of git) {
      expect(configOf(args).slice(-4)).toEqual([
        "http.curloptResolve=",
        `http.curloptResolve=github.com:443:${PUBLIC_V4}`,
        "http.followRedirects=initial",
        "transfer.bundleURI=false",
      ]);
    }
    const lfs = calls.filter((args) => subcommand(args) === "lfs");
    expect(lfs.length).toBe(lfsInstalled ? 1 : 0);
    for (const args of lfs) {
      expect(configOf(args).at(-1)).toBe("lfs.url=https://github.com/acme/widgets.git/info/lfs");
      expect(configOf(args)).toContain(`http.curloptResolve=github.com:443:${PUBLIC_V4}`);
    }
  });

  it("forces the LFS endpoint on an unrestricted forge too", async (context) => {
    resetLfsProbe();
    if (!(await isGitLfsAvailable({ stateDir: join(root, "state") }))) {
      context.skip();
      return;
    }
    const run = await sync(repoOn("git.example.org", false));
    expect(run.outcome).toBe("success");
    const lfs = networkCalls().filter((args) => subcommand(args) === "lfs");
    expect(lfs).toHaveLength(1);
    // A repository's .lfsconfig must not steer git-lfs (and the owner's
    // credential) anywhere, LAN included, on any tier that runs it.
    expect(configOf(lfs[0] ?? []).at(-1)).toMatch(/^lfs\.url=.*git\.example\.org.*\/info\/lfs$/);
  });

  it("still refuses a well-known host that resolves privately", async () => {
    const run = await sync(seededGithubRepo(), {
      resolveHost: fakeDns({ "github.com": ["10.0.0.1"] }),
    });
    expect(run.errorKind).toBe("network");
    expect(invocations()).toEqual([]);
  });

  it("gives any other restricted forge no redirects and no LFS", async () => {
    const run = await sync(repoOn("git.example.com", true), {
      resolveHost: fakeDns({ "git.example.com": [PUBLIC_V4] }),
    });
    expect(run.outcome).toBe("success");
    for (const args of networkCalls()) {
      expect(configOf(args)).toContain("http.followRedirects=false");
      expect(configOf(args).some((value) => value.startsWith("lfs.url="))).toBe(false);
    }
    expect(networkCalls().map(subcommand)).not.toContain("lfs");
  });
});

// ---------------------------------------------------------------------------
// The provider passes build restricted contexts from the forge row
// ---------------------------------------------------------------------------

describe("provider contexts", () => {
  beforeEach(() => {
    root = tempDir("egress-ctx");
    db = createTestDb(root);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function contextFor(host: string, allowPrivateNetwork: boolean): Promise<DiscoveryContext> {
    const forgeId = insertForge(db, { host, kind: "github", allowPrivateNetwork });
    const repoId = insertRepo(db, { forgeId, path: "acme/widgets" });
    const seen: DiscoveryContext[] = [];
    const provider = {
      kind: "github",
      listRepos: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined }),
        }),
      }),
      getRepoInfo: (context: DiscoveryContext) => {
        seen.push(context);
        return Promise.resolve({
          fork: { status: "unknown", rateLimited: false },
          isPrivate: null,
          sizeBytes: null,
          stars: null,
        });
      },
    } as unknown as AccountSyncProvider;
    const resolveHost = fakeDns({}, [PUBLIC_V4]);
    await lookupRepoInfo(db, repoId, {
      providerFor: () => provider,
      resolveHost,
      cooldowns: new Map(),
      anonymousBudget: new Map(),
    });
    const context = seen[0];
    if (context === undefined) {
      throw new Error("the provider was never asked");
    }
    expect(context.resolveHost).toBe(resolveHost);
    return context;
  }

  it("are restricted exactly when the forge row says so", async () => {
    expect((await contextFor("git.example.net", false)).restricted).toBe(true);
    expect((await contextFor("git.example.org", true)).restricted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Creation through the routes and import
// ---------------------------------------------------------------------------

const FORGER = "forger@example.com";

describe("creating forges", () => {
  let temp: TempApp;

  usePublicDns(
    fakeDns(
      {
        "intranet.example.com": ["10.1.2.3"],
        "mixed.example.com": [PUBLIC_V4, "fd00::5"],
        "metadata.example.com": ["169.254.169.254"],
      },
      [PUBLIC_V4],
    ),
  );

  beforeEach(async () => {
    temp = await createTempApp({ INSECURE_USER_EMAILS: FORGER });
    makeUser(temp.db, FORGER, { manage_forges: true });
  });

  afterEach(async () => {
    await temp.close();
  });

  async function post(email: string | null, payload: Record<string, unknown>) {
    return temp.app.inject({
      method: "POST",
      url: "/api/forges",
      headers: email === null ? {} : asUser(email),
      payload,
    });
  }

  function forgeCount(host: string): number {
    return (
      temp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM forges WHERE host = ?", host)?.n ?? 0
    );
  }

  it("lets a manage_forges user create a restricted forge on a public host", async () => {
    const response = await post(FORGER, { protocol: "https", host: "git.example.com" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ allowPrivateNetwork: false });
  });

  it.each([
    ["a private address", { host: "intranet.example.com" }, "not_public"],
    ["a mixed answer", { host: "mixed.example.com" }, "not_public"],
    ["cloud metadata", { host: "metadata.example.com" }, "not_public"],
    ["a non-standard port", { host: "git.example.com", port: 8443 }, "port"],
    ["http on 443", { protocol: "http", host: "git.example.com", port: 443 }, "port"],
    ["an IP literal", { host: "93.184.215.14" }, "ip_literal"],
    ["an integer IPv4", { host: "2130706433" }, "ip_literal"],
    ["a single label", { host: "gitea" }, "invalid_host"],
  ])("refuses %s, and says why without naming an address", async (_label, body, reason) => {
    const response = await post(FORGER, { protocol: "https", ...body });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "host_not_allowed", details: { reason } });
    for (const address of ["10.1.2.3", "fd00::5", "169.254.169.254"]) {
      expect(response.body).not.toContain(address);
    }
    expect(forgeCount(String(body.host))).toBe(0);
  });

  it("checks the admin's restricted forges too, but lets the admin make an unrestricted one", async () => {
    const restricted = await post(null, { protocol: "https", host: "intranet.example.com" });
    expect(restricted.statusCode).toBe(403);
    expect(restricted.json()).toMatchObject({ error: "host_not_allowed" });

    const open = await post(null, {
      protocol: "http",
      host: "intranet.example.com",
      port: 3000,
      allowPrivateNetwork: true,
    });
    expect(open.statusCode).toBe(201);
    expect(open.json()).toMatchObject({ allowPrivateNetwork: true, port: 3000 });
  });

  it("never lets a manage_forges user make an unrestricted forge", async () => {
    const response = await post(FORGER, {
      protocol: "http",
      host: "intranet.example.com",
      port: 3000,
      allowPrivateNetwork: true,
    });
    expect(response.statusCode).toBe(403);
    expect(forgeCount("intranet.example.com")).toBe(0);
  });

  it("runs the same check on import's new-host path", async () => {
    const refused = await temp.app.inject({
      method: "POST",
      url: "/api/import",
      headers: asUser(FORGER),
      payload: { text: "https://intranet.example.com/a/b" },
    });
    expect(refused.json()).toMatchObject({
      failed: 1,
      // The egress category travels through the route to the web label.
      results: [{ action: "failed", code: "host_not_allowed", reason: "not_public" }],
    });
    expect(refused.body).not.toContain("10.1.2.3");
    expect(forgeCount("intranet.example.com")).toBe(0);

    const allowed = await temp.app.inject({
      method: "POST",
      url: "/api/import",
      headers: asUser(FORGER),
      payload: { text: "https://git.example.com/a/b" },
    });
    expect(allowed.json()).toMatchObject({ created: 1 });
    expect(forgeCount("git.example.com")).toBe(1);
  });
});
