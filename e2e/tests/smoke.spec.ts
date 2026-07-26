import { expect, test } from "@playwright/test";
import {
  FIXTURE_PATH,
  FIXTURE_REPO,
  fetchRepos,
  git,
  removeDir,
  scratchDir,
  waitForFirstSync,
} from "./helpers.ts";

/**
 * The path a first-time user actually walks: import a repository, watch it back
 * itself up, look at the listing, take an export, then serve the backup out
 * over git and confirm that only reads are allowed.
 *
 * Nothing here is stubbed. It runs the built server, the built frontend, a real
 * browser, a real clone of a real public repository, and the real git binary.
 *
 * Serial on purpose: each test builds on the state the one before it left
 * behind, which is what makes the sequence a story rather than five unrelated
 * assertions.
 */
test.describe.configure({ mode: "serial" });

let gitRemotePassword: string | null = null;

test("shows the insecure mode banner on every page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Amber/);

  // The one thing that must never be missable when auth is switched off.
  const banner = page.getByText("INSECURE MODE: authentication is disabled.");
  await expect(banner).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(banner).toBeVisible();
});

test("imports a public repository through the UI", async ({ page, request }) => {
  await page.goto("/import");

  await page.getByLabel("Repository URLs").fill(FIXTURE_REPO);
  await page.getByRole("button", { name: "Preview" }).click();

  const preview = page.getByTestId("import-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator(".chip--ok")).toHaveText("1 ready");

  await page.getByRole("button", { name: /^Import 1$/ }).click();

  const results = page.getByTestId("import-results");
  await expect(results).toBeVisible();
  // Import is idempotent, so a retry of this test re-imports the same repo and
  // reports it as updated rather than created. Either outcome means it landed.
  await expect(results).toContainText(/1 (created|updated)/);

  const rows = await fetchRepos(request);
  expect(rows.map((row) => row.path)).toContain(FIXTURE_PATH);
});

test("syncs the repository and renders it in the listing", async ({ page, request }) => {
  const synced = await waitForFirstSync(request, FIXTURE_PATH);

  expect(synced.lastError).toBeNull();
  expect(synced.diskUsageBytes ?? 0).toBeGreaterThan(0);
  // The denormalized listing fields have to survive the round trip.
  expect(synced.cloneMode).toBe("bare");
  expect(synced.lastOutcome).toBe("success");

  await page.goto("/");
  const row = page.getByRole("row", { name: new RegExp(FIXTURE_PATH, "i") });
  await expect(row).toBeVisible();
  await expect(row.getByText("bare")).toBeVisible();
});

test("exports the source tree as a valid zip", async ({ request }) => {
  const rows = await fetchRepos(request);
  const repo = rows.find((row) => row.path === FIXTURE_PATH);
  expect(repo).toBeDefined();

  const response = await request.get(`/api/repos/${String(repo!.id)}/export/source.zip`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toContain(".zip");

  const body = await response.body();
  expect(body.byteLength).toBeGreaterThan(0);
  // "PK\x03\x04": a real local file header, not an empty or truncated archive.
  expect([...body.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  // The end of central directory record has to be there too, or the stream was
  // cut off and the archive only looks valid from the front.
  expect(body.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
});

test("enables the git remote and reveals the password exactly once", async ({ page, request }) => {
  // Start from off, so a retry of this test enables a remote that is already
  // on and finds no button. Disabling also destroys the old password hash,
  // which is what makes the reveal below a genuinely fresh one.
  await request.post("/api/git-remote/disable");

  await page.goto("/git-remote");

  await page.getByRole("button", { name: "Enable read-only remote" }).click();
  await page.getByRole("button", { name: "Enable and show the password" }).click();

  const reveal = page.getByTestId("password-reveal");
  await expect(reveal).toBeVisible();

  const password = await reveal.getByRole("textbox", { name: "Git remote password" }).inputValue();
  // base58: 32 characters with no look-alikes.
  expect(password).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
  gitRemotePassword = password;

  await page.reload();
  // Shown once and only once: a reload must not surface it again.
  await expect(page.getByTestId("password-reveal")).toHaveCount(0);
});

test("serves a real clone and refuses a push", async ({ request, baseURL }) => {
  expect(gitRemotePassword).not.toBeNull();
  const password = gitRemotePassword!;

  const rows = await fetchRepos(request);
  const repo = rows.find((row) => row.path === FIXTURE_PATH);
  expect(repo).toBeDefined();

  const origin = new URL(baseURL ?? "http://127.0.0.1:8099");
  const cloneUrl = `${origin.protocol}//amber:${encodeURIComponent(password)}@${origin.host}/git/${repo!.slug}.git`;

  const dir = scratchDir("clone");
  try {
    const cloned = await git(["clone", cloneUrl, "work"], dir);
    expect(cloned.code, `clone failed: ${cloned.stderr}`).toBe(0);

    const work = `${dir}/work`;
    const log = await git(["log", "--oneline"], work);
    expect(log.code, `log failed: ${log.stderr}`).toBe(0);
    // Real history came across the wire, not an empty repository.
    expect(log.stdout.trim().length).toBeGreaterThan(0);

    // A wrong password is rejected rather than quietly served.
    const denied = await git(
      ["clone", cloneUrl.replace(encodeURIComponent(password), "wrong-password"), "denied"],
      dir,
    );
    expect(denied.code).not.toBe(0);

    await git(["config", "user.email", "e2e@example.invalid"], work);
    await git(["config", "user.name", "amber e2e"], work);
    await git(["commit", "--allow-empty", "-m", "e2e: should never land"], work);

    const pushed = await git(["push", "origin", "HEAD:refs/heads/e2e"], work);
    expect(
      pushed.code,
      `a push must never succeed against a read-only remote (stderr: ${pushed.stderr})`,
    ).not.toBe(0);
    // The remote has to refuse it, rather than the push failing by accident.
    expect(pushed.stderr.toLowerCase()).toMatch(
      /read-only|403|forbidden|not supported|denied|does not appear to be a git repository/,
    );
  } finally {
    removeDir(dir);
  }
});
