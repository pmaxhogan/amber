import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activeGitProcessCount,
  classifyGitFailure,
  ensureGitRuntime,
  expectedHostForRemote,
  GitError,
  resetGitRuntime,
  runGit,
  scrubCredentials,
  shutdownGit,
} from "../src/sync/gitCli.ts";
import { tempDir } from "./helpers/gitFixtures.ts";

const execFileAsync = promisify(execFile);

const USERNAME = "amber-bot";
const PASSWORD = "s3cr3t-token-value";

let root: string;
let stateDir: string;

beforeAll(() => {
  root = tempDir("gitcli");
  stateDir = join(root, "state");
  resetGitRuntime();
});

afterAll(() => {
  resetGitRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("ensureGitRuntime", () => {
  it("creates an amber owned home, an empty hooks dir and the askpass helper", () => {
    const runtime = ensureGitRuntime(stateDir);
    expect(existsSync(runtime.homeDir)).toBe(true);
    expect(existsSync(runtime.hooksDir)).toBe(true);
    expect(existsSync(runtime.configPath)).toBe(true);
    expect(existsSync(runtime.askpassPath)).toBe(true);
    // git execs the helper directly, so the command is the plain path.
    expect(runtime.askpassCommand).toBe(runtime.askpassPath);
    expect(readFileSync(runtime.askpassPath, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
  });

  it("caches per state dir and rebuilds after a reset", () => {
    const first = ensureGitRuntime(stateDir);
    expect(ensureGitRuntime(stateDir)).toBe(first);
    resetGitRuntime();
    expect(ensureGitRuntime(stateDir)).not.toBe(first);
  });
});

describe("runGit", () => {
  it("runs git with an argument array and captures stdout", async () => {
    const result = await runGit(["--version"], { stateDir });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^git version/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("pins the hardening config on every invocation", async () => {
    const result = await runGit(["--version"], { stateDir });
    const argv = result.args.join(" ");
    expect(argv).toContain("protocol.version=2");
    expect(argv).toContain("transfer.credentialsInUrl=die");
    expect(argv).toContain("http.followRedirects=initial");
    expect(argv).toContain("submodule.recurse=false");
    expect(argv).toContain("fetch.recurseSubmodules=no");
    expect(argv).toContain("core.hooksPath=");
  });

  it("adds the working tree hardening only when asked", async () => {
    const plain = await runGit(["--version"], { stateDir });
    const worktree = await runGit(["--version"], { stateDir, workingTree: true });
    expect(plain.args.join(" ")).not.toContain("core.fsmonitor=false");
    expect(worktree.args.join(" ")).toContain("core.fsmonitor=false");
  });

  it("ignores inherited GIT_* environment variables", async () => {
    const dir = join(root, "scrub");
    mkdirSync(dir, { recursive: true });
    const hostile = join(dir, "hostile.gitconfig");
    writeFileSync(hostile, "[amber]\n\tmarker = leaked\n", "utf8");
    process.env.GIT_CONFIG_GLOBAL = hostile;
    process.env.GIT_ASKPASS = "definitely-not-amber";
    try {
      const result = await runGit(["config", "--get", "amber.marker"], {
        stateDir,
        cwd: dir,
        allowFailure: true,
      });
      expect(result.stdout.trim()).toBe("");
      expect(result.code).not.toBe(0);
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL;
      delete process.env.GIT_ASKPASS;
    }
  });

  it("throws a classified GitError on a non-zero exit", async () => {
    await expect(
      runGit(["rev-parse", "--verify", "nope"], { stateDir, cwd: root }),
    ).rejects.toThrow(GitError);
  });

  it("resolves with the exit code when failure is allowed", async () => {
    const result = await runGit(["rev-parse", "--verify", "nope"], {
      stateDir,
      cwd: root,
      allowFailure: true,
    });
    expect(result.code).not.toBe(0);
  });

  it("bounds captured output", async () => {
    const result = await runGit(["--help"], { stateDir, maxBufferBytes: 64, allowFailure: true });
    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(result.truncated).toBe(true);
  });

  it("feeds stdin when asked", async () => {
    const result = await runGit(["hash-object", "--stdin"], { stateDir, stdin: "amber\n" });
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("credential handling", () => {
  it("refuses a URL that carries userinfo", async () => {
    await expect(
      runGit(["ls-remote", `https://${USERNAME}:${PASSWORD}@example.test/x.git`], { stateDir }),
    ).rejects.toThrow(/userinfo/);
  });

  it("refuses credentials without an expected host", async () => {
    await expect(
      runGit(["ls-remote", "origin"], {
        stateDir,
        credentials: { username: USERNAME, password: PASSWORD },
      }),
    ).rejects.toThrow(/expected host/);
  });

  it("refuses to place a credential in argv", async () => {
    await expect(
      runGit(["ls-remote", "https://example.test/x.git", PASSWORD], {
        stateDir,
        expectedHost: "example.test",
        credentials: { username: USERNAME, password: PASSWORD },
      }),
    ).rejects.toThrow(/credential present in argv/);
  });

  it("derives the expected host from a single http url in argv", () => {
    expect(expectedHostForRemote("https://Example.TEST:8443/a/b.git")).toBe("example.test:8443");
    expect(expectedHostForRemote("https://example.test:443/a/b.git")).toBe("example.test");
  });

  it("scrubs userinfo out of text before it is logged or stored", () => {
    expect(scrubCredentials(`fatal: unable to access 'https://u:${PASSWORD}@h/x.git'`)).toBe(
      "fatal: unable to access 'https://h/x.git'",
    );
  });
});

describe("askpass helper", () => {
  async function askpass(
    prompt: string,
    env: Record<string, string>,
  ): Promise<{ stdout: string; code: number }> {
    const runtime = ensureGitRuntime(stateDir);
    try {
      const { stdout } = await execFileAsync(process.execPath, [runtime.askpassPath, prompt], {
        env: { ...process.env, ...env },
      });
      return { stdout, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; code?: number };
      return { stdout: failure.stdout ?? "", code: failure.code ?? 1 };
    }
  }

  const credentialEnv = {
    AMBER_GIT_HOST: "github.com",
    AMBER_GIT_USER: USERNAME,
    AMBER_GIT_PASS: PASSWORD,
  };

  it("answers a username prompt for the expected host", async () => {
    const result = await askpass("Username for 'https://github.com': ", credentialEnv);
    expect(result.stdout.trim()).toBe(USERNAME);
  });

  it("answers a password prompt for the expected host", async () => {
    const result = await askpass("Password for 'https://amber-bot@github.com': ", credentialEnv);
    expect(result.stdout.trim()).toBe(PASSWORD);
  });

  it("refuses a look-alike host that merely starts with the expected one", async () => {
    const result = await askpass("Password for 'https://github.com.evil.tld': ", credentialEnv);
    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  });

  it("refuses a host that only mentions the expected one in its path or query", async () => {
    for (const prompt of [
      "Password for 'https://evil.tld/?r=github.com': ",
      "Password for 'https://evil.tld/github.com': ",
      "Password for 'https://evil.tld#github.com': ",
    ]) {
      const result = await askpass(prompt, credentialEnv);
      expect(result.stdout).toBe("");
    }
  });

  it("refuses a different port on the expected host", async () => {
    const result = await askpass("Password for 'https://github.com:8443': ", credentialEnv);
    expect(result.stdout).toBe("");
  });

  it("refuses when no host is configured or the prompt has no url", async () => {
    expect((await askpass("Password for 'https://github.com': ", {})).stdout).toBe("");
    expect((await askpass("Password: ", credentialEnv)).stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// End to end through a real git process
// ---------------------------------------------------------------------------

interface AuthProbe {
  server: Server;
  origin: string;
  seen: string[];
}

function startAuthProbe(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<AuthProbe> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== undefined) {
      seen.push(auth);
    }
    if (handler !== undefined) {
      handler(req, res);
      return;
    }
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="amber"',
      "Content-Type": "text/plain",
    });
    res.end("unauthorized\n");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${String(address.port)}`, seen });
    });
  });
}

function decodeBasic(header: string): string {
  return Buffer.from(header.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
}

describe("credentials over a real http transport", () => {
  let probe: AuthProbe;

  beforeAll(async () => {
    probe = await startAuthProbe();
  });

  afterAll(async () => {
    await new Promise<void>((done) => {
      probe.server.close(() => {
        done();
      });
    });
  });

  afterEach(() => {
    probe.seen.length = 0;
  });

  it("offers the credential to the host it belongs to, and never in argv", async () => {
    const remote = `${probe.origin}/amber/test.git`;
    const result = await runGit(["ls-remote", remote], {
      stateDir,
      allowFailure: true,
      timeoutMs: 30_000,
      credentials: { username: USERNAME, password: PASSWORD },
      expectedHost: expectedHostForRemote(remote),
    });

    expect(probe.seen.map(decodeBasic)).toContain(`${USERNAME}:${PASSWORD}`);
    for (const arg of result.args) {
      expect(arg).not.toContain(PASSWORD);
      expect(arg).not.toMatch(/:\/\/[^/]*@/);
    }
  });

  it("withholds the credential when git prompts for a different host", async () => {
    const remote = `${probe.origin}/amber/test.git`;
    await runGit(["ls-remote", remote], {
      stateDir,
      allowFailure: true,
      timeoutMs: 30_000,
      credentials: { username: USERNAME, password: PASSWORD },
      // The stored credential belongs to a forge git is not talking to.
      expectedHost: "forge.example.test",
    });

    for (const header of probe.seen) {
      expect(decodeBasic(header)).not.toContain(PASSWORD);
    }
  });
});

describe("timeouts and shutdown", () => {
  let hanging: Server;
  let origin: string;

  beforeAll(async () => {
    hanging = createServer(() => {
      // Never responds: the client waits until amber kills it.
    });
    await new Promise<void>((done) => {
      hanging.listen(0, "127.0.0.1", () => {
        done();
      });
    });
    const address = hanging.address() as AddressInfo;
    origin = `http://127.0.0.1:${String(address.port)}/hang.git`;
  });

  afterAll(async () => {
    hanging.closeAllConnections();
    await new Promise<void>((done) => {
      hanging.close(() => {
        done();
      });
    });
  });

  it("hard kills a git process that outlives its timeout", async () => {
    const started = Date.now();
    const error = await runGit(["ls-remote", origin], { stateDir, timeoutMs: 1500 }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).kind).toBe("timeout");
    expect((error as GitError).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(activeGitProcessCount()).toBe(0);
  });

  it("kills every tracked child on shutdown", async () => {
    const pending = runGit(["ls-remote", origin], { stateDir, timeoutMs: 120_000 }).catch(
      (cause: unknown) => cause,
    );
    await new Promise((done) => setTimeout(done, 300));
    expect(activeGitProcessCount()).toBeGreaterThan(0);

    await shutdownGit(2000);
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(GitError);
    expect(activeGitProcessCount()).toBe(0);
  });
});

describe("classifyGitFailure", () => {
  const cases: [string, string][] = [
    ["fatal: Authentication failed for 'https://github.com/a/b.git'", "auth"],
    ["remote: Invalid username or password.", "auth"],
    ["fatal: could not read Username for 'https://x': terminal prompts disabled", "auth"],
    ["error: The requested URL returned error: 403", "auth"],
    ["remote: You have exceeded a secondary rate limit", "rate_limited"],
    ["error: The requested URL returned error: 429 Too Many Requests", "rate_limited"],
    ["remote: Repository not found.", "not_found"],
    ["error: The requested URL returned error: 404", "not_found"],
    ["fatal: unable to access 'https://x/': Could not resolve host: x", "network"],
    ["fatal: unable to access 'https://x/': Failed to connect to x port 443", "network"],
    ["error: RPC failed; curl 56 Recv failure: Connection reset by peer", "network"],
    ["fatal: write error: No space left on device", "disk"],
    ["error: object file is empty", "git"],
  ];

  for (const [stderr, kind] of cases) {
    it(`classifies ${kind}: ${stderr.slice(0, 40)}`, () => {
      expect(classifyGitFailure(stderr, 128)).toBe(kind);
    });
  }

  it("prefers timeout when the process was killed by the timer", () => {
    expect(classifyGitFailure("whatever", 128, true)).toBe("timeout");
  });

  it("falls back to other for a clean exit with no signal", () => {
    expect(classifyGitFailure("", 0)).toBe("other");
  });

  it("never mistakes a stored askpass helper for a credential leak", () => {
    const runtime = ensureGitRuntime(stateDir);
    expect(readFileSync(runtime.askpassPath, "utf8")).not.toContain(PASSWORD);
  });
});
