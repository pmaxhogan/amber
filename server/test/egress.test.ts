import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertForgeAllowed } from "../src/domain/forges.ts";
import type { User } from "../src/domain/users.ts";
import { getJson, ProviderError } from "../src/providers/http.ts";
import type { DiscoveryContext } from "../src/providers/types.ts";
import {
  classifyAddress,
  EgressRefusedError,
  gitPinConfig,
  isAcceptableHostname,
  isIpLiteralHost,
  isPublicAddress,
  isWellKnownPublicForge,
  lfsEndpointConfig,
  pinnedFetch,
  systemResolver,
  vetRestrictedTarget,
  vetRestrictedUrl,
  type AddressClass,
  type PinnedFetch,
  type VettedTarget,
} from "../src/security/egress.ts";
import { runGit } from "../src/sync/gitCli.ts";
import { fakeDns, PUBLIC_V4, PUBLIC_V4_B, PUBLIC_V6 } from "./helpers/egress.ts";
import { tempDir } from "./helpers/gitFixtures.ts";

// ---------------------------------------------------------------------------
// The address classifier
// ---------------------------------------------------------------------------

describe("classifyAddress", () => {
  const cases: [string, AddressClass][] = [
    // Public, as data only: none of these is ever dialed.
    [PUBLIC_V4, "public"],
    ["1.1.1.1", "public"],
    ["8.8.8.8", "public"],
    [PUBLIC_V6, "public"],
    ["2606:4700:4700::1111", "public"],
    // IPv4 ranges that are not public, at both edges where it matters.
    ["0.0.0.0", "unspecified"],
    ["0.255.255.255", "unspecified"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["100.63.255.255", "public"],
    ["100.128.0.0", "public"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link_local"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.15.255.255", "public"],
    ["172.32.0.0", "public"],
    ["192.0.0.8", "reserved"],
    ["192.0.2.1", "documentation"],
    ["192.88.99.1", "reserved"],
    ["192.168.1.1", "private"],
    ["198.18.0.1", "benchmark"],
    ["198.19.255.255", "benchmark"],
    ["198.20.0.0", "public"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.254", "reserved"],
    ["255.255.255.255", "broadcast"],
    // IPv6 ranges.
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
    ["febf:ffff::1", "link_local"],
    ["fc00::1", "unique_local"],
    ["fd12:3456::1", "unique_local"],
    ["ff02::1", "multicast"],
    ["fec0::1", "reserved"],
    ["100::1", "reserved"],
    ["2001:db8::1", "documentation"],
    ["3fff::1", "documentation"],
    ["2001:10::1", "reserved"],
    ["2001:1::1", "reserved"],
    ["4000::1", "reserved"],
    // IPv4 smuggled inside IPv6: mapped, translated and compatible forms are
    // refused whatever they embed.
    ["::ffff:127.0.0.1", "ipv4_embedded"],
    ["::ffff:7f00:1", "ipv4_embedded"],
    ["::ffff:10.0.0.1", "ipv4_embedded"],
    ["::ffff:8.8.8.8", "ipv4_embedded"],
    ["0:0:0:0:0:ffff:169.254.169.254", "ipv4_embedded"],
    ["::ffff:0:127.0.0.1", "ipv4_embedded"],
    ["::127.0.0.1", "ipv4_embedded"],
    ["::7f00:1", "ipv4_embedded"],
    ["::8.8.8.8", "ipv4_embedded"],
    // NAT64 (well-known prefix): judged by the IPv4 inside it.
    ["64:ff9b::8.8.8.8", "public"],
    ["64:ff9b::808:808", "public"],
    ["64:ff9b::127.0.0.1", "ipv4_embedded"],
    ["64:ff9b::a9fe:a9fe", "ipv4_embedded"],
    ["64:ff9b::192.168.0.1", "ipv4_embedded"],
    ["64:ff9b:1::8.8.8.8", "ipv4_embedded"],
    // 6to4: the relay IPv4 is bytes 2..5.
    ["2002:808:808::1", "public"],
    ["2002:7f00:1::1", "ipv4_embedded"],
    ["2002:c0a8:101::1", "ipv4_embedded"],
    ["2002:a00:1::", "ipv4_embedded"],
    // Teredo: server IPv4 in bytes 4..7, client IPv4 XOR 0xff in 12..15.
    ["2001:0:808:808:0:0:f7f7:f7f7", "public"],
    ["2001:0:7f00:1:0:0:f7f7:f7f7", "ipv4_embedded"],
    ["2001:0:808:808:0:0:80ff:fffe", "ipv4_embedded"],
    // Unparseable or scoped input is never public.
    ["fe80::1%eth0", "invalid"],
    ["2606:4700::1111%1", "invalid"],
    ["", "invalid"],
    ["not an address", "invalid"],
    ["256.1.1.1", "invalid"],
    ["1.2.3", "invalid"],
    ["0x7f000001", "invalid"],
    ["2130706433", "invalid"],
    ["0177.0.0.1", "invalid"],
    ["::ffff:999.0.0.1", "invalid"],
    ["1:2:3:4:5:6:7:8:9", "invalid"],
  ];

  it.each(cases)("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
    expect(isPublicAddress(address)).toBe(expected === "public");
  });

  it("accepts a bracketed IPv6 address and upper case hex", () => {
    expect(classifyAddress("[::1]")).toBe("loopback");
    expect(classifyAddress("FE80::1")).toBe("link_local");
    expect(classifyAddress("2606:4700:4700::1111".toUpperCase())).toBe("public");
  });
});

// ---------------------------------------------------------------------------
// Host names
// ---------------------------------------------------------------------------

describe("isIpLiteralHost", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "2130706433",
    "0x7f000001",
    "0X7F000001",
    "0177.0.0.1",
    "0x7f.0.0.1",
    "127.1",
    "127.0.1",
    "127.0.0.1.",
    "1.2.3.4.5",
    "example.com.123",
    "foo.0x10",
    "[::1]",
    "::1",
    "[::ffff:127.0.0.1]",
    "fe80::1%25eth0",
  ])("%s is an IP literal", (host) => {
    expect(isIpLiteralHost(host)).toBe(true);
  });

  it.each(["example.com", "git.example.com", "xn--bcher-kva.example", "1password.example.com"])(
    "%s is a name",
    (host) => {
      expect(isIpLiteralHost(host)).toBe(false);
    },
  );
});

describe("isAcceptableHostname", () => {
  it.each([
    ["example.com", true],
    ["git.example.com", true],
    ["xn--bcher-kva.example", true],
    ["a-b.example.org", true],
    ["localhost", false],
    ["gitea", false],
    ["Example.com", false],
    ["-bad.example.com", false],
    ["bad-.example.com", false],
    ["under_score.example.com", false],
    ["example.com.", false],
    ["exa mple.com", false],
    ["bücher.example", false],
    ["", false],
    [`${"a".repeat(64)}.example.com`, false],
  ] as const)("%s -> %s", (host, ok) => {
    expect(isAcceptableHostname(host)).toBe(ok);
  });
});

// ---------------------------------------------------------------------------
// The one rule: vetRestrictedTarget
// ---------------------------------------------------------------------------

async function refusal(promise: Promise<unknown>): Promise<EgressRefusedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EgressRefusedError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an egress refusal");
}

describe("vetRestrictedTarget", () => {
  const dns = fakeDns({
    "git.example.com": [PUBLIC_V4, PUBLIC_V6],
    "two.example.com": [PUBLIC_V4, PUBLIC_V4, PUBLIC_V4_B],
    "intranet.example.com": ["10.20.30.40"],
    "mixed.example.com": [PUBLIC_V4, "192.168.7.7"],
    "mapped.example.com": ["::ffff:127.0.0.1"],
    "metadata.example.com": ["169.254.169.254"],
    "garbage.example.com": ["not-an-ip"],
  });

  it("allows a normal public host on the standard ports and returns every answer", async () => {
    await expect(
      vetRestrictedTarget({ protocol: "https", host: "git.example.com", port: null }, dns),
    ).resolves.toEqual({
      protocol: "https",
      host: "git.example.com",
      port: 443,
      addresses: [PUBLIC_V4, PUBLIC_V6],
    });
    await expect(
      vetRestrictedTarget({ protocol: "http", host: "git.example.com", port: 80 }, dns),
    ).resolves.toMatchObject({ port: 80 });
    await expect(
      vetRestrictedTarget({ protocol: "https", host: "Git.Example.com", port: 443 }, dns),
    ).resolves.toMatchObject({ host: "git.example.com" });
    // Duplicate answers are collapsed.
    await expect(
      vetRestrictedTarget({ protocol: "https", host: "two.example.com", port: null }, dns),
    ).resolves.toMatchObject({ addresses: [PUBLIC_V4, PUBLIC_V4_B] });
  });

  const refusals: [string, { protocol: string; host: string; port: number | null }, string][] = [
    ["https on 8443", { protocol: "https", host: "git.example.com", port: 8443 }, "port"],
    ["https on 80", { protocol: "https", host: "git.example.com", port: 80 }, "port"],
    ["http on 443", { protocol: "http", host: "git.example.com", port: 443 }, "port"],
    ["http on 8080", { protocol: "http", host: "git.example.com", port: 8080 }, "port"],
    ["ssh", { protocol: "ssh", host: "git.example.com", port: null }, "scheme"],
    ["file", { protocol: "file", host: "", port: null }, "scheme"],
    ["an IPv4 literal", { protocol: "https", host: "93.184.215.14", port: null }, "ip_literal"],
    ["a decimal integer", { protocol: "https", host: "2130706433", port: null }, "ip_literal"],
    ["a hex integer", { protocol: "https", host: "0x7f000001", port: null }, "ip_literal"],
    ["an octal quad", { protocol: "https", host: "0177.0.0.1", port: null }, "ip_literal"],
    ["a short quad", { protocol: "https", host: "127.1", port: null }, "ip_literal"],
    ["a bracketed IPv6", { protocol: "https", host: "[::1]", port: null }, "ip_literal"],
    ["a bare IPv6", { protocol: "https", host: "2606:4700::1111", port: null }, "ip_literal"],
    ["a single label", { protocol: "https", host: "gitea", port: null }, "invalid_host"],
    ["localhost", { protocol: "https", host: "localhost", port: null }, "invalid_host"],
    ["an underscore", { protocol: "https", host: "a_b.example.com", port: null }, "invalid_host"],
    [
      "a private answer",
      { protocol: "https", host: "intranet.example.com", port: null },
      "not_public",
    ],
    ["a mixed answer", { protocol: "https", host: "mixed.example.com", port: null }, "not_public"],
    [
      "a mapped answer",
      { protocol: "https", host: "mapped.example.com", port: null },
      "not_public",
    ],
    [
      "cloud metadata",
      { protocol: "https", host: "metadata.example.com", port: null },
      "not_public",
    ],
    [
      "a garbage answer",
      { protocol: "https", host: "garbage.example.com", port: null },
      "not_public",
    ],
    ["no answer", { protocol: "https", host: "nowhere.example.com", port: null }, "unresolvable"],
  ];

  it.each(refusals)("refuses %s", async (_label, target, reason) => {
    const error = await refusal(vetRestrictedTarget(target, dns));
    expect(error.reason).toBe(reason);
    expect(error.code).toBe("host_not_allowed");
    expect(error.status).toBe(403);
    expect(error.details).toEqual({ reason });
  });

  it("never names a resolved address in the message, only in the log-only field", async () => {
    const error = await refusal(
      vetRestrictedTarget({ protocol: "https", host: "mixed.example.com", port: null }, dns),
    );
    expect(error.message).toContain("mixed.example.com");
    expect(error.message).toMatch(/not public/);
    expect(error.message).not.toContain("192.168.7.7");
    expect(error.message).not.toContain(PUBLIC_V4);
    expect(JSON.stringify(error.details)).not.toContain("192.168");
    expect(error.addresses).toEqual([
      { address: PUBLIC_V4, class: "public" },
      { address: "192.168.7.7", class: "private" },
    ]);
  });

  it("does not resolve at all before the shape checks pass", async () => {
    const asked: string[] = [];
    const spy = (host: string): Promise<string[]> => {
      asked.push(host);
      return Promise.resolve([PUBLIC_V4]);
    };
    await refusal(
      vetRestrictedTarget({ protocol: "https", host: "git.example.com", port: 1 }, spy),
    );
    await refusal(vetRestrictedTarget({ protocol: "https", host: "10.0.0.1", port: null }, spy));
    expect(asked).toEqual([]);
  });

  it("vets a URL the same way, and refuses userinfo in it", async () => {
    await expect(
      vetRestrictedUrl("https://git.example.com/api/v1/x?y=1", dns),
    ).resolves.toMatchObject({ host: "git.example.com", port: 443 });
    expect((await refusal(vetRestrictedUrl("https://git.example.com:444/", dns))).reason).toBe(
      "port",
    );
    expect((await refusal(vetRestrictedUrl("http://0x7f000001/", dns))).reason).toBe("ip_literal");
    expect((await refusal(vetRestrictedUrl("http://[::1]/", dns))).reason).toBe("ip_literal");
    const withCredential = await refusal(
      vetRestrictedUrl("https://u:hunter2@git.example.com/", dns),
    );
    expect(withCredential.reason).toBe("invalid_host");
    expect(withCredential.message).not.toContain("hunter2");
    expect((await refusal(vetRestrictedUrl("not a url", dns))).reason).toBe("invalid_host");
  });
});

describe("systemResolver", () => {
  // The rest of the suite replaces the resolver, so this is the one place the
  // production lookup runs. "localhost" is answered from the hosts file, not
  // from DNS, so it needs no network.
  it("returns every address for a name, and nothing for one that does not resolve", async () => {
    const answers = await systemResolver("localhost");
    expect(answers.length).toBeGreaterThan(0);
    for (const address of answers) {
      expect(classifyAddress(address)).toBe("loopback");
    }
    await expect(systemResolver("")).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Creation: the forges seam
// ---------------------------------------------------------------------------

function fakeUser(isAdmin: boolean): User {
  return { isAdmin, permissions: { manage_forges: true } } as unknown as User;
}

describe("assertForgeAllowed", () => {
  const dns = fakeDns({ "git.example.com": [PUBLIC_V4], "lan.example.com": ["192.168.1.5"] });

  it("runs the restricted rule for everyone, the admin included", async () => {
    for (const actor of [fakeUser(true), fakeUser(false)]) {
      await expect(
        assertForgeAllowed(
          { protocol: "https", host: "git.example.com", port: null },
          actor,
          { allowPrivateNetwork: false },
          dns,
        ),
      ).resolves.toBeUndefined();
      const error = await refusal(
        assertForgeAllowed(
          { protocol: "https", host: "lan.example.com", port: null },
          actor,
          { allowPrivateNetwork: false },
          dns,
        ),
      );
      expect(error.reason).toBe("not_public");
    }
  });

  it("lets the admin create an unrestricted forge anywhere, without resolving it", async () => {
    const never = (): Promise<string[]> => Promise.reject(new Error("must not resolve"));
    await expect(
      assertForgeAllowed(
        { protocol: "http", host: "10.0.0.9", port: 3000 },
        fakeUser(true),
        { allowPrivateNetwork: true },
        never,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses an unrestricted forge to anyone but the admin, even if a caller forgets", async () => {
    await expect(
      assertForgeAllowed(
        { protocol: "http", host: "10.0.0.9", port: 3000 },
        fakeUser(false),
        { allowPrivateNetwork: true },
        dns,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

// ---------------------------------------------------------------------------
// git: the pin itself
// ---------------------------------------------------------------------------

describe("gitPinConfig", () => {
  it("resets, pins every validated address (IPv6 bracketed), and turns redirects off", () => {
    const vetted: VettedTarget = {
      protocol: "https",
      host: "git.example.com",
      port: 443,
      addresses: [PUBLIC_V4, PUBLIC_V6],
    };
    expect(gitPinConfig(vetted)).toEqual([
      ["http.curloptResolve", ""],
      ["http.curloptResolve", `git.example.com:443:${PUBLIC_V4},[${PUBLIC_V6}]`],
      ["http.followRedirects", "false"],
      ["transfer.bundleURI", "false"],
    ]);
  });
});

describe("the well-known public forge tier", () => {
  it.each([
    [{ protocol: "https", host: "github.com", port: null }, true],
    [{ protocol: "https", host: "github.com", port: 443 }, true],
    [{ protocol: "https", host: "GitLab.com", port: null }, true],
    [{ protocol: "https", host: "bitbucket.org", port: null }, true],
    [{ protocol: "https", host: "codeberg.org", port: null }, true],
    [{ protocol: "http", host: "github.com", port: null }, false],
    [{ protocol: "https", host: "github.com", port: 8443 }, false],
    [{ protocol: "https", host: "www.github.com", port: null }, false],
    [{ protocol: "https", host: "github.com.evil.example", port: null }, false],
    [{ protocol: "https", host: "git.example.com", port: null }, false],
  ] as const)("%o -> %s", (target, expected) => {
    expect(isWellKnownPublicForge(target)).toBe(expected);
  });

  it("keeps git's default redirect handling only when asked, and the pin always", () => {
    const vetted: VettedTarget = {
      protocol: "https",
      host: "github.com",
      port: 443,
      addresses: [PUBLIC_V4],
    };
    expect(gitPinConfig(vetted, { followRedirects: true })).toEqual([
      ["http.curloptResolve", ""],
      ["http.curloptResolve", `github.com:443:${PUBLIC_V4}`],
      ["http.followRedirects", "initial"],
      ["transfer.bundleURI", "false"],
    ]);
    expect(gitPinConfig(vetted)).toContainEqual(["http.followRedirects", "false"]);
  });

  it("derives the LFS endpoint the way git-lfs does", () => {
    expect(lfsEndpointConfig("https://github.com/acme/widgets.git")).toEqual([
      ["lfs.url", "https://github.com/acme/widgets.git/info/lfs"],
    ]);
    expect(lfsEndpointConfig("https://github.com/acme/widgets")).toEqual([
      ["lfs.url", "https://github.com/acme/widgets.git/info/lfs"],
    ]);
  });
});

describe("forcing the LFS endpoint with a real git-lfs", () => {
  let root: string;

  beforeEach(() => {
    root = tempDir("egress-lfs");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ignores a repository .lfsconfig that names another server", async (context) => {
    const stateDir = join(root, "state");
    const probe = await runGit(["lfs", "version"], { stateDir, allowFailure: true });
    if (probe.code !== 0) {
      context.skip();
      return;
    }
    const work = join(root, "work");
    const bare = join(root, "bare.git");
    const remote = "https://github.com/acme/widgets.git";
    await runGit(["init", "--quiet", work], { stateDir });
    writeFileSync(
      join(work, ".lfsconfig"),
      '[lfs]\n\turl = https://evil.example.net/lfs\n[remote "origin"]\n\tlfsurl = https://evil.example.net/other\n',
    );
    await runGit(["add", ".lfsconfig"], { cwd: work, stateDir });
    await runGit(
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "x"],
      { cwd: work, stateDir },
    );
    await runGit(["clone", "--quiet", "--bare", work, bare], { stateDir, allowFileProtocol: true });
    await runGit(["config", "--local", "remote.origin.url", remote], { cwd: bare, stateDir });

    // Control: without the override, git-lfs does follow the repository.
    const open = await runGit(["lfs", "env"], { cwd: bare, stateDir, allowFailure: true });
    expect(open.stdout).toContain("Endpoint=https://evil.example.net/lfs");

    const forced = await runGit(["lfs", "env"], {
      cwd: bare,
      stateDir,
      allowFailure: true,
      configList: lfsEndpointConfig(remote),
    });
    expect(forced.stdout).toContain(`Endpoint=${remote}/info/lfs`);
    expect(forced.stdout).not.toContain("evil.example.net");
  });
});

interface Recorder {
  server: Server;
  port: number;
  seen: { host: string | undefined; url: string | undefined }[];
}

async function startServer(
  host: string,
  handler: (
    request: IncomingMessage,
    respond: (status: number, headers?: Record<string, string>, body?: string) => void,
  ) => void,
): Promise<Recorder> {
  const seen: Recorder["seen"] = [];
  const server = createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url });
    handler(request, (status, headers = {}, body = "") => {
      response.writeHead(status, headers);
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      resolve();
    });
  });
  return { server, port: (server.address() as AddressInfo).port, seen };
}

async function stop(recorder: Recorder | undefined): Promise<void> {
  if (recorder === undefined) {
    return;
  }
  recorder.server.closeAllConnections();
  await new Promise<void>((resolve) => {
    recorder.server.close(() => {
      resolve();
    });
  });
}

describe("http.curloptResolve with a real git", () => {
  let root: string;
  let stateDir: string;
  let servers: Recorder[];

  beforeEach(() => {
    root = tempDir("egress-git");
    stateDir = join(root, "state");
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) {
      await stop(server);
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function serve(
    host: string,
    handler: Parameters<typeof startServer>[1] = (_request, respond) => {
      respond(404);
    },
  ): Promise<Recorder> {
    const recorder = await startServer(host, handler);
    servers.push(recorder);
    return recorder;
  }

  it("connects a name that resolves nowhere to the pinned IPv4 address", async () => {
    const target = await serve("127.0.0.1");
    // .invalid can never resolve (RFC 6761), so reaching the server at all
    // proves git used the pin rather than a resolver.
    const pin = gitPinConfig({
      protocol: "http",
      host: "pinned.invalid",
      port: target.port,
      addresses: ["127.0.0.1"],
    });
    const result = await runGit(
      ["ls-remote", `http://pinned.invalid:${String(target.port)}/r.git`],
      {
        configList: pin,
        stateDir,
        allowFailure: true,
      },
    );
    expect(result.code).not.toBe(0);
    expect(target.seen.length).toBeGreaterThan(0);
    expect(target.seen[0]?.host).toBe(`pinned.invalid:${String(target.port)}`);
    expect(target.seen[0]?.url).toBe("/r.git/info/refs?service=git-upload-pack");
    // The pin rides in argv, which must never carry a credential.
    expect(result.args).toContain(
      `http.curloptResolve=pinned.invalid:${String(target.port)}:127.0.0.1`,
    );
  });

  it("connects to a pinned IPv6 address written in brackets", async (context) => {
    let target: Recorder;
    try {
      target = await serve("::1");
    } catch {
      context.skip();
      return;
    }
    const result = await runGit(
      ["ls-remote", `http://pinned6.invalid:${String(target.port)}/r.git`],
      {
        configList: gitPinConfig({
          protocol: "http",
          host: "pinned6.invalid",
          port: target.port,
          addresses: ["::1"],
        }),
        stateDir,
        allowFailure: true,
      },
    );
    expect(result.args).toContain(
      `http.curloptResolve=pinned6.invalid:${String(target.port)}:[::1]`,
    );
    expect(target.seen[0]?.host).toBe(`pinned6.invalid:${String(target.port)}`);
  });

  it("does not follow a redirect to another host, which the default would", async () => {
    const elsewhere = await serve("127.0.0.1", (_request, respond) => {
      respond(404);
    });
    const origin = await serve("127.0.0.1", (request, respond) => {
      respond(302, {
        location: `http://elsewhere.invalid:${String(elsewhere.port)}${request.url ?? "/"}`,
      });
    });
    const pin = gitPinConfig({
      protocol: "http",
      host: "origin.invalid",
      port: origin.port,
      addresses: ["127.0.0.1"],
    });
    // Make the other host reachable too, so the only thing keeping git off it
    // is the redirect policy and not a failed lookup.
    const reachable: [string, string] = [
      "http.curloptResolve",
      `elsewhere.invalid:${String(elsewhere.port)}:127.0.0.1`,
    ];
    const url = `http://origin.invalid:${String(origin.port)}/r.git`;

    const pinned = await runGit(["ls-remote", url], {
      configList: [...pin, reachable],
      stateDir,
      allowFailure: true,
    });
    expect(pinned.code).not.toBe(0);
    expect(origin.seen.length).toBeGreaterThan(0);
    expect(elsewhere.seen).toEqual([]);

    // Control: with git's default (`initial`) the same redirect IS followed,
    // so the assertion above is measuring the policy.
    await runGit(["ls-remote", url], {
      configList: [...pin, reachable, ["http.followRedirects", "initial"]],
      stateDir,
      allowFailure: true,
    });
    expect(elsewhere.seen.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Provider HTTP: the pinned transport
// ---------------------------------------------------------------------------

describe("pinnedFetch", () => {
  let recorder: Recorder | undefined;

  afterEach(async () => {
    await stop(recorder);
    recorder = undefined;
  });

  function pinFor(port: number, host = "pinned.invalid"): VettedTarget {
    return { protocol: "http", host, port, addresses: ["127.0.0.1"] };
  }

  it("connects to the pinned address and still sends the original Host", async () => {
    recorder = await startServer("127.0.0.1", (_request, respond) => {
      respond(200, { "content-type": "application/json", "x-thing": "yes" }, '{"ok":true}');
    });
    const response = await pinnedFetch(
      `http://pinned.invalid:${String(recorder.port)}/api/v1/user?x=1`,
      { method: "GET", headers: { accept: "application/json", authorization: "token t" } },
      pinFor(recorder.port),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-thing")).toBe("yes");
    expect(await response.json()).toEqual({ ok: true });
    expect(recorder.seen).toEqual([
      { host: `pinned.invalid:${String(recorder.port)}`, url: "/api/v1/user?x=1" },
    ]);
  });

  it("hands back redirects and empty bodies as they are", async () => {
    recorder = await startServer("127.0.0.1", (request, respond) => {
      if (request.url === "/moved") {
        respond(301, { location: "https://elsewhere.invalid/" });
      } else {
        respond(204);
      }
    });
    const moved = await pinnedFetch(
      `http://pinned.invalid:${String(recorder.port)}/moved`,
      {},
      pinFor(recorder.port),
    );
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("https://elsewhere.invalid/");
    const empty = await pinnedFetch(
      `http://pinned.invalid:${String(recorder.port)}/empty`,
      {},
      pinFor(recorder.port),
    );
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    expect(recorder.seen).toHaveLength(2);
  });

  it("refuses a URL that is not the pinned host, port or protocol", async () => {
    recorder = await startServer("127.0.0.1", (_request, respond) => {
      respond(200);
    });
    const pin = pinFor(recorder.port);
    for (const url of [
      `http://other.invalid:${String(recorder.port)}/`,
      `http://pinned.invalid:${String(recorder.port + 1)}/`,
      `https://pinned.invalid:${String(recorder.port)}/`,
    ]) {
      await expect(pinnedFetch(url, {}, pin)).rejects.toBeInstanceOf(EgressRefusedError);
    }
    expect(recorder.seen).toEqual([]);
  });

  it("reports a timeout as a TimeoutError", async () => {
    recorder = await startServer("127.0.0.1", () => {
      // Never answers.
    });
    await expect(
      pinnedFetch(
        `http://pinned.invalid:${String(recorder.port)}/slow`,
        { signal: AbortSignal.timeout(50) },
        pinFor(recorder.port),
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

// ---------------------------------------------------------------------------
// Provider HTTP: the policy, through getJson
// ---------------------------------------------------------------------------

describe("getJson on a restricted forge", () => {
  interface Call {
    url: string;
    pin: VettedTarget;
  }

  function transport(
    calls: Call[],
    answer: (url: string) => Response = () => Response.json({ ok: true }),
  ): PinnedFetch {
    return (url, _init, pin) => {
      calls.push({ url, pin });
      return Promise.resolve(answer(url));
    };
  }

  function restricted(overrides: Partial<DiscoveryContext>): DiscoveryContext {
    return {
      baseUrl: "https://git.example.com",
      username: "octocat",
      token: null,
      visibility: "all",
      restricted: true,
      ...overrides,
    };
  }

  it("vets the URL actually requested and pins the connection to what passed", async () => {
    const calls: Call[] = [];
    const context = restricted({
      resolveHost: fakeDns({ "api.example.com": [PUBLIC_V4] }),
      pinnedFetch: transport(calls),
      // Must be ignored: an arbitrary fetch cannot be pinned.
      fetch: () => Promise.reject(new Error("the injected fetch must not be used")),
    });
    const response = await getJson<{ ok: boolean }>(context, "https://api.example.com/repos/a/b");
    expect(response.data).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: "https://api.example.com/repos/a/b",
        pin: { protocol: "https", host: "api.example.com", port: 443, addresses: [PUBLIC_V4] },
      },
    ]);
  });

  it("refuses at request time a host that resolved public before and private now", async () => {
    const answers = [[PUBLIC_V4], ["10.0.0.7"]];
    const calls: Call[] = [];
    const context = restricted({
      resolveHost: () => Promise.resolve(answers.shift() ?? []),
      pinnedFetch: transport(calls),
    });
    await getJson(context, "https://git.example.com/api/v1/repos/a/b");
    const error = await getJson(context, "https://git.example.com/api/v1/repos/a/b").catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "network" });
    expect((error as Error).message).toMatch(/not public/);
    expect((error as Error).message).not.toContain("10.0.0.7");
    expect(calls).toHaveLength(1);
  });

  it("refuses a mixed answer", async () => {
    const calls: Call[] = [];
    const context = restricted({
      resolveHost: fakeDns({ "git.example.com": [PUBLIC_V4, "127.0.0.1"] }),
      pinnedFetch: transport(calls),
    });
    await expect(getJson(context, "https://git.example.com/api/v1/x")).rejects.toMatchObject({
      kind: "network",
    });
    expect(calls).toEqual([]);
  });

  it("does not follow a cross-host redirect, and re-vets a same-host one", async () => {
    const asked: string[] = [];
    const resolveHost = (host: string): Promise<string[]> => {
      asked.push(host);
      return Promise.resolve([PUBLIC_V4]);
    };
    const calls: Call[] = [];
    const crossHost = restricted({
      resolveHost,
      pinnedFetch: transport(
        calls,
        () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example.net/x" } }),
      ),
    });
    await expect(getJson(crossHost, "https://git.example.com/api/v1/x")).rejects.toMatchObject({
      kind: "invalid_response",
    });
    expect(calls).toHaveLength(1);
    expect(asked).toEqual(["git.example.com"]);

    asked.length = 0;
    calls.length = 0;
    const sameHost = restricted({
      resolveHost,
      pinnedFetch: transport(calls, (url) =>
        url.endsWith("/old")
          ? new Response(null, { status: 301, headers: { location: "/api/v1/new" } })
          : Response.json({ moved: true }),
      ),
    });
    const response = await getJson(sameHost, "https://git.example.com/api/v1/old");
    expect(response.data).toEqual({ moved: true });
    expect(calls.map((call) => call.url)).toEqual([
      "https://git.example.com/api/v1/old",
      "https://git.example.com/api/v1/new",
    ]);
    expect(asked).toEqual(["git.example.com", "git.example.com"]);
  });

  it("leaves an unrestricted forge exactly as before: its own fetch, no resolution", async () => {
    const urls: string[] = [];
    const context: DiscoveryContext = {
      baseUrl: "http://10.0.0.9:3000",
      username: "",
      token: null,
      visibility: "all",
      restricted: false,
      resolveHost: () => Promise.reject(new Error("must not resolve")),
      pinnedFetch: () => Promise.reject(new Error("must not pin")),
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(Response.json([]));
      },
    };
    await getJson(context, "http://10.0.0.9:3000/api/v1/repos");
    expect(urls).toEqual(["http://10.0.0.9:3000/api/v1/repos"]);
  });
});
