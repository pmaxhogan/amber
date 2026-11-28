import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { allowLoopbackForge, git, removeDir, scratchDir } from "./helpers.ts";
import { must, startLocalGitServer, type LocalGitServer } from "./localGitServer.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Multi-user access control, end to end, through the real UI with three
 * identities: the admin (the default in insecure mode) and two friends who
 * hold the default permissions. A friend is a request carrying
 * X-Amber-Insecure-User, which the server only honours for the addresses in
 * INSECURE_USER_EMAILS (see playwright.config.ts).
 *
 * Nothing touches the internet: every repository is built here and served
 * from a throwaway loopback server. The loopback forge is created by the admin
 * first, because a new host needs the admin or manage_forges.
 *
 * That forge reaches a private address, so it is UNRESTRICTED: the admin's
 * alone (a friend's import there is refused like an unknown host), and every
 * repository on it is private whatever any fetch says. No forge a friend may
 * import from reaches a test server, so the friends own nothing here, and the
 * cross-user scenarios run on the admin's repositories with
 * view_others_private: granted, a friend sees and clones; revoked, it answers
 * 404 exactly like one that does not exist.
 *
 * Serial: each test builds on what the one before it left behind.
 */
test.describe.configure({ mode: "serial" });

const ADMIN = "admin";
const FRIEND_A = "friend-a@example.com";
const FRIEND_B = "friend-b@example.com";
const GB = 1024 ** 3;

interface Row {
  id: number;
  path: string;
  slug: string;
  displayName: string;
  mine?: boolean;
  isPrivate?: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
}

interface UserSummary {
  id: number;
  email: string;
  isAdmin: boolean;
  storageCapBytes: number | null;
  hasGitPassword: boolean;
  permissions: Record<string, boolean>;
}

let server: LocalGitServer;
let baseURL: string;
let admin: APIRequestContext;
let a: APIRequestContext;
let b: APIRequestContext;
let contexts: BrowserContext[] = [];
const users = new Map<string, UserSummary>();
let gitUsernameA = "";
let gitPasswordA = "";

const names = {
  seed: "mu-seed",
  secret: "mu-secret",
  a: "mu-a-repo",
  b: "mu-b-repo",
} as const;

async function buildTiny(work: string, text: string): Promise<void> {
  writeFileSync(join(work, "README.md"), `# ${text}\n\n${text}\n`);
  await must(["add", "-A"], work);
  await must(["commit", "--quiet", "-m", `initial ${text}`], work);
}

async function list(request: APIRequestContext): Promise<Row[]> {
  const response = await request.get("/api/repos?perPage=200");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { rows: Row[] }).rows;
}

async function find(request: APIRequestContext, name: string): Promise<Row | undefined> {
  return (await list(request)).find((row) => row.path === `t/${name}`);
}

async function waitSynced(request: APIRequestContext, name: string): Promise<Row> {
  const deadline = Date.now() + 90_000;
  let row: Row | undefined;
  while (Date.now() < deadline) {
    row = await find(request, name);
    if (row?.lastError) throw new Error(`${name} failed to sync: ${row.lastError}`);
    if (row?.lastSuccessAt != null) return row;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${name} did not sync in time: ${JSON.stringify(row)}`);
}

async function importAs(request: APIRequestContext, text: string): Promise<void> {
  const response = await request.post("/api/import", { data: { text } });
  expect(response.status(), await response.text()).toBe(200);
}

async function loadUsers(): Promise<UserSummary[]> {
  const response = await admin.get("/api/users");
  expect(response.status()).toBe(200);
  const rows = ((await response.json()) as { rows: UserSummary[] }).rows;
  for (const row of rows) users.set(row.email, row);
  return rows;
}

async function open(
  email: string | typeof ADMIN,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await newContext(email);
  return { page: await context.newPage(), context };
}

let browserRef: import("@playwright/test").Browser;

async function newContext(email: string | typeof ADMIN): Promise<BrowserContext> {
  const context = await browserRef.newContext({
    baseURL,
    ...(email === ADMIN ? {} : { extraHTTPHeaders: { "X-Amber-Insecure-User": email } }),
  });
  contexts.push(context);
  return context;
}

/** The users table row for one person, by the email it shows. */
function userRow(page: Page, email: string) {
  return page.locator("tbody", { hasText: email });
}

async function toggle(page: Page, email: string, key: string): Promise<void> {
  const id = users.get(email)!.id;
  await page.locator(`#perm-${String(id)}-${key}`).click({ force: true });
  await expect(page.getByText("Permission saved").first()).toBeVisible();
}

test.beforeAll(async ({ playwright, browser }, testInfo) => {
  browserRef = browser;
  baseURL = String(testInfo.project.use.baseURL);
  const make = (headers: Record<string, string>) =>
    playwright.request.newContext({ baseURL, extraHTTPHeaders: headers });
  admin = await make({});
  a = await make({ "X-Amber-Insecure-User": FRIEND_A });
  b = await make({ "X-Amber-Insecure-User": FRIEND_B });

  server = await startLocalGitServer();
  for (const name of Object.values(names)) {
    await server.addRepo(name, (work) => buildTiny(work, name));
  }

  // The first request as a friend admits them (and creates their row).
  expect((await a.get("/api/me")).status()).toBe(200);
  expect((await b.get("/api/me")).status()).toBe(200);
  await loadUsers();
});

test.afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  contexts = [];
  await Promise.all([admin?.dispose(), a?.dispose(), b?.dispose()]);
  await server?.close();
});

test("the admin seeds the loopback forge and one repository only the admin can see", async () => {
  // A NEW host needs the admin, and a loopback one has to be allowed to reach a
  // non-public address. Both are the admin's alone.
  const forgeId = await allowLoopbackForge(baseURL, server.origin);
  await importAs(admin, server.urlFor(names.seed));
  const seed = await waitSynced(admin, names.seed);

  // An authenticated fetch on a forge Amber cannot ask (generic) is private.
  // The loopback forge is generic and the dumb HTTP server ignores the token.
  const account = await admin.post("/api/accounts", {
    data: { forgeId, username: "tok", secret: "not-a-real-token" },
  });
  expect(account.status(), await account.text()).toBeLessThan(300);

  const withAccount = server.urlFor(names.secret).replace("http://", "http://tok@");
  await importAs(admin, withAccount);
  const secret = await waitSynced(admin, names.secret);
  expect(secret.isPrivate, "an authenticated fetch of a generic forge is private").toBe(true);
  // Fetched anonymously, but on an unrestricted forge: that only proves Amber
  // could reach it, so it stays private.
  expect(seed.isPrivate, "an unrestricted forge never derives public").toBe(true);
});

test("the admin's Users page lists both friends, toggles a permission and sets a cap", async () => {
  const { page } = await open(ADMIN);
  await page.goto("/users");
  await expect(page.getByTestId("users-table")).toBeVisible();
  await expect(userRow(page, FRIEND_A)).toBeVisible();
  await expect(userRow(page, FRIEND_B)).toBeVisible();

  // Export off for friend A, and the server really holds it.
  await toggle(page, FRIEND_A, "export");
  expect(
    ((await (await a.get("/api/me")).json()) as { permissions: Record<string, boolean> })
      .permissions.export,
  ).toBe(false);
  // And back on, so the rest of the run starts from the defaults.
  await toggle(page, FRIEND_A, "export");
  expect(
    ((await (await a.get("/api/me")).json()) as { permissions: Record<string, boolean> })
      .permissions.export,
  ).toBe(true);

  // A cap of 5 GB for friend B.
  const idB = users.get(FRIEND_B)!.id;
  await page.locator(`#cap-${String(idB)}`).fill("5");
  // The number input commits its value on blur.
  await page.locator(`#cap-${String(idB)}`).blur();
  await userRow(page, FRIEND_B).getByRole("button", { name: "Save cap" }).click();
  await expect(page.getByText("Cap saved").first()).toBeVisible();
  const rows = await loadUsers();
  expect(rows.find((row) => row.email === FRIEND_B)?.storageCapBytes).toBe(5 * GB);
  expect(rows.find((row) => row.email === FRIEND_A)?.storageCapBytes).toBeNull();
});

test("friend A sees only the navigation their permissions allow", async () => {
  const { page } = await open(FRIEND_A);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const label of ["Repos", "Import", "Account Sync", "Git Remote", "About"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  for (const label of ["Users", "Settings", "Removed", "Forges & Accounts"]) {
    await expect(nav.getByRole("link", { name: label })).toHaveCount(0);
  }

  // A page the caller may not use sends them back to the repo list.
  await page.goto("/users");
  await expect(page).toHaveURL(/\/$/);
  await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0);
  // And the API says no as well, whatever the UI hides.
  expect((await a.get("/api/users")).status()).toBe(403);
});

test("friend A cannot import from the admin's LAN forge, nor from a host Amber does not have", async () => {
  const { page } = await open(FRIEND_A);

  // A host Amber does not have yet is refused: A may not add forges. `localhost`
  // is a different host from the loopback forge the admin created. The preview
  // already says so, and nothing is importable.
  const foreign = server.urlFor("elsewhere").replace("127.0.0.1", "localhost");
  await page.goto("/import");
  await page.getByLabel("Repository URLs").fill(foreign);
  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByTestId("import-preview");
  await expect(preview.locator(".chip--error")).toHaveText("1 rejected");
  await expect(preview).toContainText(/not enabled/i);
  await expect(page.getByRole("button", { name: /^Import 0$/ })).toBeDisabled();
  // A commit that skips the preview carries the machine-readable code.
  const direct = await a.post("/api/import", { data: { text: foreign } });
  const refused = (await direct.json()) as { results: { code?: string; action: string }[] };
  expect(refused.results[0]).toMatchObject({ action: "failed", code: "host_not_enabled" });

  // The admin's loopback forge reaches a private address, so it is the admin's
  // alone: refused with exactly the same answer, in the UI and the API.
  await page.goto("/import");
  await page.getByLabel("Repository URLs").fill(server.urlFor(names.a));
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("import-preview").locator(".chip--error")).toHaveText("1 rejected");
  await expect(page.getByTestId("import-preview")).toContainText(/not enabled/i);
  const lan = await a.post("/api/import", { data: { text: server.urlFor(names.a) } });
  const lanBody = (await lan.json()) as { results: { code?: string; action: string }[] };
  expect(lanBody.results[0]).toMatchObject({ action: "failed", code: "host_not_enabled" });
  expect(await find(admin, names.a)).toBeUndefined();
});

test("friend A cannot see the admin's private repository", async () => {
  expect(await find(a, names.secret)).toBeUndefined();
  const secret = (await find(admin, names.secret))!;
  expect((await a.get(`/api/repos/${String(secret.id)}`)).status()).toBe(404);
});

test("friend B cannot see the admin's repository until granted view_others_private", async () => {
  const seed = (await find(admin, names.seed))!;
  // With the defaults (view_others_public only) B sees none of the admin's
  // repositories: on an unrestricted forge they are all private.
  expect(await find(b, names.seed)).toBeUndefined();
  expect(await find(b, names.secret)).toBeUndefined();
  expect((await b.get(`/api/repos/${String(seed.id)}`)).status()).toBe(404);

  const { page: adminPage } = await open(ADMIN);
  await adminPage.goto("/users");
  await toggle(adminPage, FRIEND_B, "view_others_private");
  expect((await b.get(`/api/repos/${String(seed.id)}`)).status()).toBe(200);
});

test("friend B sees the admin's repository but cannot change it", async () => {
  const seed = (await find(admin, names.seed))!;
  const { page } = await open(FRIEND_B);

  await page.goto("/");
  await page.locator(".repo-cell__name", { hasText: seed.displayName }).first().click();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  // No controls for a repository B can see but may not modify.
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);

  // The API refuses as well, rather than trusting the UI.
  const paused = await b.patch(`/api/repos/${String(seed.id)}`, { data: { state: "paused" } });
  expect(paused.status()).toBe(403);
  const deleted = await b.delete(`/api/repos/${String(seed.id)}`);
  expect(deleted.status()).toBe(403);
  expect((await find(admin, names.seed))?.id).toBe(seed.id);
});

test("turning off view_others_private hides the admin's repository from B entirely", async () => {
  const seed = (await find(admin, names.seed))!;
  const { page } = await open(ADMIN);
  await page.goto("/users");
  await toggle(page, FRIEND_B, "view_others_private");

  // A repository B cannot view answers exactly like one that does not exist.
  expect(await find(b, names.seed)).toBeUndefined();
  expect((await b.get(`/api/repos/${String(seed.id)}`)).status()).toBe(404);

  const { page: bPage } = await open(FRIEND_B);
  await bPage.goto("/");
  await expect(bPage.locator(".repo-cell__name", { hasText: seed.displayName })).toHaveCount(0);
  expect(await find(b, names.secret)).toBeUndefined();
});

test("a personal git credential clones what the user can view and nothing else", async () => {
  expect((await admin.post("/api/git-remote/enable")).status()).toBe(200);

  const { page } = await open(FRIEND_A);
  await page.goto("/git-remote");
  await expect(page.getByTestId("remote-state")).toHaveText("remote on");
  await page.getByRole("button", { name: "Create password" }).click();
  const reveal = page.getByTestId("password-reveal");
  await expect(reveal).toBeVisible();
  gitPasswordA = await reveal.getByRole("textbox", { name: "Git password" }).inputValue();
  gitUsernameA = ((await page.getByTestId("git-username").textContent()) ?? "").trim();
  expect(gitUsernameA).toMatch(/^[a-z0-9]{10}$/);

  const origin = new URL(baseURL);
  const url = (slug: string, password = gitPasswordA) =>
    `${origin.protocol}//${gitUsernameA}:${encodeURIComponent(password)}@${origin.host}/git/${slug}.git`;

  const seed = (await find(admin, names.seed))!;
  const dir = scratchDir("multiuser-clone");
  try {
    // A repository A cannot view is the same 404 as one that does not exist.
    const refused = await git(["clone", url(seed.slug), "refused"], dir);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/not found|404|does not appear to be a git repository/i);

    // Once A may view it, the same credential clones it.
    const { page: adminPage } = await open(ADMIN);
    await adminPage.goto("/users");
    await toggle(adminPage, FRIEND_A, "view_others_private");
    const cloned = await git(["clone", url(seed.slug), "seed"], dir);
    expect(cloned.code, `clone failed: ${cloned.stderr}`).toBe(0);
    const log = await git(["log", "--oneline"], `${dir}/seed`);
    expect(log.stdout.trim().length).toBeGreaterThan(0);
  } finally {
    removeDir(dir);
  }
});

test("the admin revokes A's git password and A's clone then fails", async () => {
  const { page } = await open(ADMIN);
  await page.goto("/users");
  const row = userRow(page, FRIEND_A);
  await expect(row.getByTestId("has-git")).toBeVisible();
  await row.getByRole("button", { name: "Revoke git password" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Git password revoked").first()).toBeVisible();
  await expect(row.getByTestId("has-git")).toHaveCount(0);

  const origin = new URL(baseURL);
  const seed = (await find(admin, names.seed))!;
  const dir = scratchDir("multiuser-revoked");
  try {
    const cloned = await git(
      [
        "clone",
        `${origin.protocol}//${gitUsernameA}:${encodeURIComponent(gitPasswordA)}@${origin.host}/git/${seed.slug}.git`,
        "revoked",
      ],
      dir,
    );
    expect(cloned.code, "a revoked credential must not clone").not.toBe(0);
  } finally {
    removeDir(dir);
  }
  // A's own page agrees that the password is gone.
  const state = (await (await a.get("/api/git-remote")).json()) as { hasPassword: boolean };
  expect(state.hasPassword).toBe(false);
});

test("a user at a zero storage cap sees the banner and a new import is refused", async () => {
  const idB = users.get(FRIEND_B)!.id;
  // B owns nothing (no forge here that B may import from reaches a test
  // server), so the cap is 0: usage 0 is at it. The UI takes whole
  // hundredths of a GB, so the cap goes through the API the page uses.
  const capped = await admin.patch(`/api/users/${String(idB)}`, { data: { storageCapBytes: 0 } });
  expect(capped.status(), await capped.text()).toBe(200);

  const { page } = await open(FRIEND_B);
  await page.goto("/");
  await expect(page.getByTestId("cap-banner")).toBeVisible();
  await expect(page.getByTestId("cap-banner")).toContainText("storage limit");

  // github.com is seeded and restricted, so B may import from it; the cap
  // refuses the line before anything is created, so nothing reaches the
  // network.
  const line = "https://github.com/example/amber-e2e-never-fetched";
  await page.goto("/import");
  await page.getByLabel("Repository URLs").fill(line);
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: /^Import 1$/ }).click();
  await expect(page.getByTestId("import-failure")).toContainText("Storage limit reached");

  // Nothing new was created.
  const rows = (await list(b)).filter((row) => row.mine === true);
  expect(rows).toEqual([]);
  expect((await list(admin)).some((row) => row.path === "example/amber-e2e-never-fetched")).toBe(
    false,
  );

  // The Users page marks the row.
  const { page: adminPage } = await open(ADMIN);
  await adminPage.goto("/users");
  await expect(userRow(adminPage, FRIEND_B).getByTestId("over-cap")).toBeVisible();
});
