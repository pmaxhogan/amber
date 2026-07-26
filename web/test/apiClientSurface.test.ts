import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { makeAccount, makeForge, makeRepo, makeRun, makeStatus } from "./helpers/stubApi.ts";

/**
 * Every method on the client, exercised once against a stubbed fetch.
 *
 * Two things are locked here that nothing else checks. First the REQUEST: the
 * path, the verb, and the body each method sends, so a renamed route or a
 * dropped query parameter fails a test rather than a deployment. Second the
 * RESPONSE PARSE: each stub answers in the shape the real server answers in
 * (verified against it in server/test/routes/contracts.test.ts), so a client
 * schema that drifts away from the server stops parsing here.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function harness(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (status === 204) {
      return new Response(null, { status });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  const api = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  return { api, calls };
}

const GIT_REMOTE = {
  enabled: true,
  username: "amber",
  cloneUrlTemplate: "http://amber:{password}@localhost:8080/git/{slug}.git",
  rotatedAt: 1_700_000_000_000,
};

describe("health and status", () => {
  it("reads healthz", async () => {
    const { api, calls } = harness({ ok: true, version: "1.2.3" });
    await expect(api.health()).resolves.toEqual({ ok: true, version: "1.2.3" });
    expect(calls[0]).toMatchObject({ url: "/healthz", method: "GET" });
  });

  it("reads status", async () => {
    const { api, calls } = harness(makeStatus({ activeSyncs: 2 }));
    await expect(api.status()).resolves.toMatchObject({ activeSyncs: 2 });
    expect(calls[0]?.url).toBe("/api/status");
  });
});

describe("forges", () => {
  it("lists, creates, updates and deletes", async () => {
    const forge = makeForge();

    const list = harness([forge]);
    await expect(list.api.listForges()).resolves.toHaveLength(1);
    expect(list.calls[0]?.url).toBe("/api/forges");

    const created = harness(forge);
    await created.api.createForge({ protocol: "https", host: "github.com", port: null });
    expect(created.calls[0]).toMatchObject({
      url: "/api/forges",
      method: "POST",
      body: { host: "github.com" },
    });

    // Only kind is mutable: host, port and protocol are immutable by design.
    const patched = harness({ ...forge, kind: "gitea" });
    await patched.api.updateForge(1, "gitea");
    expect(patched.calls[0]).toMatchObject({
      url: "/api/forges/1",
      method: "PATCH",
      body: { kind: "gitea" },
    });

    const removed = harness(null, 204);
    await removed.api.deleteForge(1);
    expect(removed.calls[0]).toMatchObject({ url: "/api/forges/1", method: "DELETE" });
  });
});

describe("accounts", () => {
  it("lists with an optional forge filter", async () => {
    const unfiltered = harness([makeAccount()]);
    await unfiltered.api.listAccounts();
    expect(unfiltered.calls[0]?.url).toBe("/api/accounts");

    const filtered = harness([makeAccount()]);
    await filtered.api.listAccounts(4);
    expect(filtered.calls[0]?.url).toBe("/api/accounts?forgeId=4");
  });

  it("creates, updates, promotes and deletes", async () => {
    const account = makeAccount();

    const created = harness(account);
    await created.api.createAccount({
      forgeId: 1,
      username: "octocat",
      secret: "pat",
      isDefault: false,
    });
    expect(created.calls[0]).toMatchObject({ url: "/api/accounts", method: "POST" });

    // A null secret clears the stored credential; omitting it leaves it alone.
    const cleared = harness({ ...account, hasSecret: false });
    await cleared.api.updateAccount(1, { secret: null });
    expect(cleared.calls[0]).toMatchObject({
      url: "/api/accounts/1",
      method: "PATCH",
      body: { secret: null },
    });

    const promoted = harness({ ...account, isDefault: true });
    await promoted.api.setDefaultAccount(1);
    expect(promoted.calls[0]).toMatchObject({ url: "/api/accounts/1/default", method: "POST" });

    const removed = harness(null, 204);
    await removed.api.deleteAccount(1);
    expect(removed.calls[0]).toMatchObject({ url: "/api/accounts/1", method: "DELETE" });
  });

  it("never surfaces a secret, because the response shape has no field for one", async () => {
    const { api } = harness(makeAccount({ hasSecret: true }));
    const account = await api.setDefaultAccount(1);
    expect(Object.keys(account)).not.toContain("secret");
    expect(account.hasSecret).toBe(true);
  });
});

describe("import", () => {
  const preview = {
    results: [{ line: "github.com/a/b", lineNumber: 1, status: "ok" }],
    summary: { total: 1, ok: 1, warning: 0, error: 0 },
  };

  it("previews without committing", async () => {
    const { api, calls } = harness(preview);
    await api.previewImport("github.com/a/b");
    expect(calls[0]).toMatchObject({
      url: "/api/import/preview",
      method: "POST",
      body: { text: "github.com/a/b" },
    });
  });

  it("commits", async () => {
    const { api, calls } = harness({
      results: [{ ...preview.results[0], action: "created", repoId: 1 }],
      created: 1,
      updated: 0,
      failed: 0,
    });
    await expect(api.commitImport("github.com/a/b")).resolves.toMatchObject({ created: 1 });
    expect(calls[0]).toMatchObject({ url: "/api/import", method: "POST" });
  });
});

describe("repos", () => {
  const page = { rows: [makeRepo()], total: 1, page: 1, perPage: 50 };

  it("passes the listing query through", async () => {
    const { api, calls } = harness(page);
    await api.listRepos({ page: 2, perPage: 25, sort: "last_sync_at", dir: "desc", q: "node" });
    expect(calls[0]?.url).toBe("/api/repos?page=2&perPage=25&sort=last_sync_at&dir=desc&q=node");
  });

  it("parses the denormalized listing fields", async () => {
    const { api } = harness({
      ...page,
      rows: [makeRepo({ cloneMode: "mirror", syncEnabled: false, lastOutcome: "error" })],
    });
    const result = await api.listRepos({});
    expect(result.rows[0]).toMatchObject({
      cloneMode: "mirror",
      syncEnabled: false,
      lastOutcome: "error",
    });
  });

  it("reads, patches, syncs and lists runs", async () => {
    const repo = makeRepo();

    const one = harness(repo);
    await one.api.getRepo(1);
    expect(one.calls[0]?.url).toBe("/api/repos/1");

    const patched = harness({ ...repo, state: "paused" });
    await patched.api.updateRepo(1, { state: "paused" });
    expect(patched.calls[0]).toMatchObject({ method: "PATCH", body: { state: "paused" } });

    const synced = harness(repo);
    await synced.api.syncRepo(1);
    expect(synced.calls[0]).toMatchObject({ url: "/api/repos/1/sync", method: "POST" });

    const runs = harness({ rows: [makeRun()], total: 1, page: 1, perPage: 20 });
    await runs.api.listRuns(1, 2, 10);
    expect(runs.calls[0]?.url).toBe("/api/repos/1/runs?page=2&perPage=10");
  });

  it("carries the files flag on delete, because it also removes the backup", async () => {
    const without = harness(null, 204);
    await without.api.deleteRepo(1);
    expect(without.calls[0]?.url).toBe("/api/repos/1?files=false");

    const withFiles = harness(null, 204);
    await withFiles.api.deleteRepo(1, true);
    expect(withFiles.calls[0]?.url).toBe("/api/repos/1?files=true");
  });

  it("returns the whole bulk result, including the ids that no longer exist", async () => {
    const { api, calls } = harness({
      action: "delete",
      requested: 3,
      affected: 2,
      ids: [1, 2],
      missing: [9],
    });
    const result = await api.bulkRepos([1, 2, 9], "delete", true);
    expect(result).toMatchObject({ affected: 2, missing: [9] });
    expect(calls[0]).toMatchObject({
      url: "/api/repos/bulk",
      method: "POST",
      body: { ids: [1, 2, 9], action: "delete", files: true },
    });
  });
});

describe("settings", () => {
  const envelope = (values: Record<string, unknown>) => ({
    scopeType: "global",
    scopeId: null,
    values,
  });

  it("unwraps the envelope on read and write", async () => {
    const read = harness(envelope({ clone_mode: "mirror" }));
    await expect(read.api.getSettings({ scopeType: "global", scopeId: null })).resolves.toEqual({
      clone_mode: "mirror",
    });

    const written = harness(envelope({}));
    const cleared = await written.api.putSettings(
      { scopeType: "repo", scopeId: 7 },
      { clone_mode: null },
    );
    expect(cleared).toEqual({});
    expect(written.calls[0]).toMatchObject({
      url: "/api/settings/repo/7",
      method: "PUT",
      body: { clone_mode: null },
    });
  });

  it("returns only the explanation from effective-settings", async () => {
    const { api, calls } = harness({
      repoId: 3,
      settings: { clone_mode: "bare" },
      explanation: { clone_mode: { value: "bare", source: "default", sourceId: null } },
    });
    const explained = await api.getEffectiveSettings(3);
    expect(explained).toEqual({
      clone_mode: { value: "bare", source: "default", sourceId: null },
    });
    expect(calls[0]?.url).toBe("/api/repos/3/effective-settings");
  });
});

describe("account syncs", () => {
  const sync = {
    id: 1,
    accountId: 2,
    source: "owned",
    visibility: "all",
    enabled: true,
    intervalMinutes: 360,
    nextRunAt: null,
    lastRunAt: null,
    lastError: null,
    reposDiscovered: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  it("unwraps the rows envelope on list", async () => {
    const { api } = harness({ rows: [sync] });
    await expect(api.listAccountSyncs()).resolves.toEqual([sync]);
  });

  it("creates, updates, runs and deletes", async () => {
    const created = harness(sync);
    await created.api.createAccountSync({ accountId: 2, source: "starred" });
    expect(created.calls[0]).toMatchObject({
      url: "/api/account-syncs",
      method: "POST",
      body: { accountId: 2, source: "starred" },
    });

    const patched = harness({ ...sync, enabled: false });
    await patched.api.updateAccountSync(1, { enabled: false });
    expect(patched.calls[0]).toMatchObject({ url: "/api/account-syncs/1", method: "PATCH" });

    const ran = harness({});
    await ran.api.runAccountSync(1);
    expect(ran.calls[0]).toMatchObject({ url: "/api/account-syncs/1/run", method: "POST" });

    const removed = harness(null, 204);
    await removed.api.deleteAccountSync(1);
    expect(removed.calls[0]).toMatchObject({ url: "/api/account-syncs/1", method: "DELETE" });
  });
});

describe("git remote", () => {
  it("reads the config without a password", async () => {
    const { api } = harness(GIT_REMOTE);
    const config = await api.getGitRemote();
    expect(Object.keys(config)).not.toContain("password");
  });

  it("returns the one-time password on enable and rotate", async () => {
    const enabled = harness({ ...GIT_REMOTE, password: "s3cret" });
    await expect(enabled.api.enableGitRemote()).resolves.toMatchObject({ password: "s3cret" });
    expect(enabled.calls[0]).toMatchObject({ url: "/api/git-remote/enable", method: "POST" });

    const rotated = harness({ ...GIT_REMOTE, password: "fresh" });
    await expect(rotated.api.rotateGitRemote()).resolves.toMatchObject({ password: "fresh" });
    expect(rotated.calls[0]?.url).toBe("/api/git-remote/rotate");
  });

  it("disables without returning a password", async () => {
    const { api, calls } = harness({ ...GIT_REMOTE, enabled: false });
    await expect(api.disableGitRemote()).resolves.toMatchObject({ enabled: false });
    expect(calls[0]?.url).toBe("/api/git-remote/disable");
  });

  it("renames the user with a PATCH carrying only the username", async () => {
    const { api, calls } = harness({ ...GIT_REMOTE, username: "backups" });
    await expect(api.setGitRemoteUsername("backups")).resolves.toMatchObject({
      username: "backups",
    });
    expect(calls[0]).toMatchObject({
      url: "/api/git-remote",
      method: "PATCH",
      body: { username: "backups" },
    });
  });
});

describe("export and file streaming", () => {
  it("builds export urls for every kind and format", () => {
    const { api } = harness({});
    expect(api.exportUrl(5, "source", "zip")).toBe("/api/repos/5/export/source.zip");
    expect(api.exportUrl(5, "gitdir", "tar.gz")).toBe("/api/repos/5/export/gitdir.tar.gz");
    expect(api.exportUrl(5, "gitdir", "7z")).toBe("/api/repos/5/export/gitdir.7z");
  });

  it("downloads an export as a blob so the auth cookie is carried", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(new Blob(["zip-bytes"]), { status: 200 });
    });
    const api = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const blob = await api.downloadExport(5, "source", "zip");
    expect(blob.size).toBeGreaterThan(0);
    expect(calls[0]).toBe("/api/repos/5/export/source.zip");
  });

  it("pages the file manifest and streams one blob", async () => {
    const tree = harness({
      ref: "abc123",
      rows: [{ path: "README.md", mode: "100644", size: 12, oid: "def456" }],
      total: 1,
      page: 1,
      perPage: 200,
    });
    const manifest = await tree.api.listTree(5, { ref: "main", page: 1, perPage: 200 });
    expect(manifest.ref).toBe("abc123");
    expect(tree.calls[0]?.url).toBe("/api/repos/5/tree?ref=main&page=1&perPage=200");

    const fetchImpl = vi.fn(async () => new Response(new Blob(["file"]), { status: 200 }));
    const api = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.getBlob(5, "README.md", "main")).resolves.toBeInstanceOf(Blob);
  });

  it("points the event stream at the SSE endpoint", () => {
    const { api } = harness({});
    expect(api.eventsUrl()).toBe("/api/events");
  });
});

describe("base url", () => {
  it("prefixes every path, so a test or an embed can point elsewhere", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(makeStatus()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const api = createApiClient({
      baseUrl: "http://amber.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await api.status();
    expect(calls[0]).toBe("http://amber.test/api/status");
    expect(api.eventsUrl()).toBe("http://amber.test/api/events");
  });
});
