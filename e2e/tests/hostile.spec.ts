import type { BrowserContext, Locator, Page } from "@playwright/test";
import { armDetectors, type Detectors } from "./detectors.ts";
import { expect, test, type HostileFixture } from "./fixtures.ts";
import { HOSTILE } from "./hostileRepo.ts";

/**
 * Permanent regression suite for hostile repository content, in real
 * Chromium against the built app. One repository carries hostile file and
 * directory names, ref names, commit text, markdown (a corpus of script
 * tags, handlers, javascript: links, mXSS shapes, remote and path-escaping
 * images, forged link attributes), an SVG that scripts, and an HTML page
 * named like a PNG. The suite walks all of it through the real UI and
 * asserts that nothing ran, nothing reached out, and nothing escaped its
 * sandbox. The detectors are proven against a page that really misbehaves
 * before any of that counts for anything.
 *
 * Chromium logs CSP violation console messages for markup that was parsed but
 * never executed, so this spec deliberately does not assert a clean console;
 * hygiene.spec.ts does that for normal content.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function arm(context: BrowserContext, page: Page, baseURL: string): Promise<Detectors> {
  return armDetectors(context, [page], new URL(baseURL).origin);
}

function clean(d: Detectors, step: string): void {
  expect(d.events, `hostile content misbehaved during: ${step}`).toEqual([]);
}

/** Close any window opened by a link the test clicked, leaving the pages it owns. */
async function closePopups(context: BrowserContext, keep: Page[]): Promise<void> {
  for (const page of context.pages()) {
    if (!keep.includes(page)) await page.close().catch(() => undefined);
  }
}

const row = (page: Page, name: string): Locator =>
  page
    .locator("button.file-list__row")
    .filter({
      has: page.locator(".file-list__name", { hasText: new RegExp(`^${escapeRe(name)}$`) }),
    })
    .first();

async function openBrowse(page: Page, repo: HostileFixture): Promise<void> {
  await page.goto("/");
  await page.locator(".repo-cell__name", { hasText: repo.displayName }).first().click();
  await page.getByRole("tab", { name: "Browse" }).click();
  await expect(page.locator(".file-list")).toBeVisible();
}

async function openFile(page: Page, repo: HostileFixture, parts: string[]): Promise<void> {
  await openBrowse(page, repo);
  for (const part of parts) {
    await row(page, part).click();
    await page.waitForTimeout(250);
  }
}

/** Wait until a markdown frame (or its plain-text fallback) is on screen, then let it settle. */
async function settleMarkdown(page: Page): Promise<void> {
  await expect(
    page.locator("iframe[sandbox], .markdown-frame-fallback, .file-view__note").first(),
  ).toBeAttached();
  await page.waitForTimeout(600);
}

const frameOf = (page: Page) => page.frameLocator("iframe[sandbox]").first();

/** Something that changes whenever the app moved to another path or file. */
async function where(page: Page): Promise<string> {
  const crumbs = await page
    .getByRole("navigation", { name: "Path" })
    .innerText({ timeout: 500 })
    .catch(() => "");
  const file = await page
    .locator(".file-view__name")
    .innerText({ timeout: 500 })
    .catch(() => "");
  return `${crumbs}|${file}`;
}

/**
 * Left-click every link of the rendered frame, one at a time, asserting
 * after each. A link that the app follows moves the view, so the page is
 * reopened and the walk carries on from the next link.
 */
async function clickEveryLink(
  page: Page,
  context: BrowserContext,
  d: Detectors,
  reopen: () => Promise<void>,
  label: string,
): Promise<number> {
  await settleMarkdown(page);
  const total = await frameOf(page).locator("a").count();
  let clicked = 0;
  for (let index = 0; index < total; index += 1) {
    if ((await page.locator("iframe[sandbox]").count()) === 0) {
      await reopen();
      await settleMarkdown(page);
    }
    const link = frameOf(page).locator("a").nth(index);
    const href = (await link.getAttribute("href", { timeout: 1500 }).catch(() => null)) ?? "";
    const before = await where(page);
    d.allowPopups(/^(https?:|mailto:)/i.test(href.trim()));
    await link.click({ force: true, timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(250);
    d.allowPopups(false);
    clicked += 1;
    clean(d, `${label}: link ${String(index)} (${href.slice(0, 80)})`);
    await closePopups(context, [page]);
    if ((await where(page)) !== before) {
      await reopen();
      await settleMarkdown(page);
    }
  }
  return clicked;
}

// ---------------------------------------------------------------------------

test("positive control: every detector fires on a page that really misbehaves", async ({
  context,
  page,
  baseURL,
}) => {
  const d = await arm(context, page, baseURL ?? "http://127.0.0.1:8099");

  // A real navigation first: init scripts only run in documents created after they are added.
  await page.goto("/healthz");
  await page.setContent(`<!doctype html><body><script>
    alert("control");
    window.__pwn();
    fetch("https://attacker.invalid/control").catch(function () {});
    window.open("https://attacker.invalid/popup");
    var f = document.createElement("iframe");
    f.srcdoc = "x";
    document.body.appendChild(f);
    f.addEventListener("load", function once() {
      f.removeEventListener("load", once);
      f.removeAttribute("srcdoc");
      f.src = "data:text/html,moved";
    });
  </script></body>`);

  for (const kind of ["DIALOG", "CANARY", "REQUEST", "FRAMENAV", "NEWPAGE", "POPUP-WITH-OPENER"]) {
    await expect
      .poll(() => d.events.some((event) => event.startsWith(kind)), {
        message: `the ${kind} detector never fired on the control page`,
      })
      .toBe(true);
  }
});

test("the README of a hostile repository renders inert, and none of its links do harm", async ({
  context,
  page,
  baseURL,
  hostileRepo,
}) => {
  const d = await arm(context, page, baseURL ?? "");
  await openBrowse(page, hostileRepo);
  await settleMarkdown(page);

  await expect(page.locator("iframe[sandbox]")).toHaveCount(1);
  await expect(page.locator("iframe[sandbox]")).toHaveAttribute("sandbox", "allow-same-origin");
  await expect(frameOf(page).getByRole("heading", { name: "Hostile Root" })).toBeVisible();
  // No element the payloads asked for made it into the frame.
  for (const selector of ["script", "iframe", "object", "embed", "form", "meta", "base", "link"]) {
    await expect(
      frameOf(page).locator("body").locator(selector),
      `<${selector}> in the frame body`,
    ).toHaveCount(0);
  }
  clean(d, "README render");

  const clicked = await clickEveryLink(
    page,
    context,
    d,
    async () => openBrowse(page, hostileRepo),
    "README",
  );
  expect(clicked).toBeGreaterThan(0);
  clean(d, "README links");
});

test("every payload family renders inert and its links do no harm", async ({
  context,
  page,
  baseURL,
  hostileRepo,
}) => {
  const d = await arm(context, page, baseURL ?? "");
  let totalLinks = 0;
  for (const file of hostileRepo.familyFiles) {
    const open = async (): Promise<void> => openFile(page, hostileRepo, ["payloads", file]);
    await open();
    await settleMarkdown(page);
    await expect(page.locator(".file-view__name")).toHaveText(file);
    clean(d, `${file} render`);
    if (file === "nul.md") {
      // Binary to the app: a download, never a rendered page.
      await expect(page.locator(".file-view__note")).toContainText("Binary file");
      await expect(page.locator("iframe[sandbox]")).toHaveCount(0);
      continue;
    }

    // Every in-repo image the family asks for is a raw-endpoint URL of this repository.
    const sources = await frameOf(page)
      .locator("img")
      .evaluateAll((images: { getAttribute(name: string): string | null }[]) =>
        images.map((image) => image.getAttribute("src") ?? ""),
      );
    for (const source of sources) {
      expect(source, `${file}: image source`).toMatch(
        new RegExp(`^${escapeRe(new URL(baseURL ?? "").origin)}/api/repos/\\d+/browse/raw\\?`),
      );
    }

    totalLinks += await clickEveryLink(page, context, d, open, file);
    clean(d, `${file} links`);
  }
  // The walk really clicked links, not an empty set.
  expect(totalLinks).toBeGreaterThan(5);
});

test("hostile file and directory names are literal text and open safely", async ({
  context,
  page,
  baseURL,
  request,
  hostileRepo,
}) => {
  const d = await arm(context, page, baseURL ?? "");
  const n = HOSTILE.names;
  await openFile(page, hostileRepo, ["names"]);

  for (const name of [n.htmlFile, n.quoteFile, n.dashFile, n.encodedFile, n.htmlDir, n.symlink]) {
    await expect(
      page.locator(".file-list__name").filter({ hasText: new RegExp(`^${escapeRe(name)}$`) }),
      `${name} listed as literal text`,
    ).toHaveCount(1);
  }
  // The name was not parsed as markup anywhere in the list or the crumbs.
  await expect(page.locator(".file-list b, .file-list img, .file-list script")).toHaveCount(0);
  clean(d, "names listing");

  for (const name of [n.htmlFile, n.quoteFile, n.dashFile, n.encodedFile]) {
    await openFile(page, hostileRepo, ["names", name]);
    await expect(page.locator(".file-view__name"), name).toHaveText(name);
    await expect(page.locator(".code-view")).toBeVisible();
    await expect(page.locator(".file-view img, .file-view script")).toHaveCount(0);

    // Its download link is a raw-endpoint URL that answers as an attachment.
    const href = await page.locator("a.file-view__download").getAttribute("href");
    expect(href).toContain("/browse/raw");
    const raw = await request.get(new URL(href ?? "", baseURL ?? "").href);
    expect(raw.status(), `raw ${name}`).toBe(200);
    expect(raw.headers()["content-disposition"] ?? "", `raw ${name}`).toMatch(/^attachment/);
    expect(raw.headers()["content-disposition"] ?? "").not.toMatch(/[<>\r\n]/);
    expect(raw.headers()["x-content-type-options"]).toBe("nosniff");
    clean(d, `file ${name}`);
  }

  await openFile(page, hostileRepo, ["names", n.htmlDir]);
  await expect(page.getByRole("navigation", { name: "Path" })).toContainText(n.htmlDir);
  await expect(page.getByRole("navigation", { name: "Path" }).locator("b")).toHaveCount(0);
  await settleMarkdown(page);
  await expect(frameOf(page).getByRole("heading", { name: "Dir Readme" })).toBeVisible();
  clean(d, "hostile directory");

  await openFile(page, hostileRepo, ["names", n.symlink]);
  await expect(page.locator(".file-view__note")).toContainText(
    `Symbolic link to ${HOSTILE.symlinkTarget}`,
  );
  await expect(page.locator('a[href^="javascript" i]')).toHaveCount(0);
  clean(d, "symlink");
});

test("hostile ref names, history and commit text stay text", async ({
  context,
  page,
  baseURL,
  hostileRepo,
}) => {
  const d = await arm(context, page, baseURL ?? "");
  await openBrowse(page, hostileRepo);
  const picker = page.locator(".ref-picker__button");
  await picker.click();

  const names = page.locator(".ref-picker__name");
  await expect(names.filter({ hasText: new RegExp(`^${escapeRe(HOSTILE.branch)}$`) })).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: /^Tags \(/ }).click();
  await expect(names.filter({ hasText: new RegExp(`^${escapeRe(HOSTILE.tag)}$`) })).toHaveCount(1);
  await expect(page.locator(".ref-picker__panel img, .ref-picker__panel script")).toHaveCount(0);
  clean(d, "ref picker lists");

  await page.getByRole("button", { name: /^Branches \(/ }).click();
  await names.filter({ hasText: new RegExp(`^${escapeRe(HOSTILE.branch)}$`) }).click();
  await expect(picker).toContainText(HOSTILE.branch);
  await expect(row(page, "branch-only.txt")).toBeVisible();
  clean(d, "picking the hostile branch");

  const jump = page.getByRole("textbox", { name: "Jump to a branch, tag or commit" });
  await jump.fill(HOSTILE.tag);
  await jump.press("Enter");
  await expect(picker).toContainText(HOSTILE.tag);
  await jump.fill("<img src=x onerror=alert(1)>");
  await jump.press("Enter");
  await expect(page.locator(".rev-jump__message")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator(".rev-jump__message img")).toHaveCount(0);
  clean(d, "jump input");

  // Back to main for the history walk.
  await openBrowse(page, hostileRepo);
  await page
    .getByRole("group", { name: "What to show" })
    .getByRole("button", { name: "History" })
    .click();
  const subjects = page.locator(".history-pane__subject");
  const expected = [...hostileRepo.commits.slice(0, 2)].reverse();
  await expect(subjects).toHaveCount(expected.length);
  for (const [index, commit] of expected.entries()) {
    await expect(subjects.nth(index)).toHaveText(commit.subject);
  }
  await expect(page.locator(".history-pane__list img, .history-pane__list script")).toHaveCount(0);
  clean(d, "history list");

  for (const [index, commit] of expected.entries()) {
    await subjects.nth(index).click();
    await expect(page.locator(".commit-view__subject")).toHaveText(commit.subject);
    if (commit.body.trim() !== "") {
      await expect(page.locator(".commit-view__body")).toHaveText(commit.body);
    }
    const facts = page.locator(".commit-view__facts");
    await expect(facts).toContainText(commit.authorName);
    await expect(facts).toContainText(commit.authorEmail);
    await expect(
      page.locator(".commit-view img, .commit-view script, .commit-view svg"),
    ).toHaveCount(0);
    await page.waitForTimeout(300);
    clean(d, `commit view ${commit.sha.slice(0, 7)}`);
    await page.getByRole("button", { name: "Back to history" }).click();
  }
});

test("a scripted SVG and an HTML page named .png are never executed or inlined", async ({
  context,
  page,
  baseURL,
  request,
  hostileRepo,
}) => {
  const d = await arm(context, page, baseURL ?? "");
  const origin = new URL(baseURL ?? "").origin;
  const rev = hostileRepo.commits[1]!.sha;
  const rawUrl = (path: string, inline: boolean): string => {
    const query = new URLSearchParams({ rev, path });
    if (inline) query.set("inline", "1");
    return `${origin}/api/repos/${String(hostileRepo.id)}/browse/raw?${query.toString()}`;
  };

  // The file views in the UI.
  await openFile(page, hostileRepo, ["assets", HOSTILE.names.svg]);
  await expect(page.locator(".file-view__name")).toHaveText(HOSTILE.names.svg);
  await page.waitForTimeout(800);
  clean(d, "svg file view");
  const source = page.getByRole("button", { name: "Source" });
  if ((await source.count()) > 0) {
    await source.click();
    await expect(page.locator(".code-view__code")).toContainText("<script>");
    clean(d, "svg source view");
  }
  await openFile(page, hostileRepo, ["assets", HOSTILE.names.fakePng]);
  await page.waitForTimeout(800);
  clean(d, "fake png file view");

  // Headers of every raw response.
  for (const [path, inline] of [
    [`assets/${HOSTILE.names.svg}`, true],
    [`assets/${HOSTILE.names.svg}`, false],
    [`assets/${HOSTILE.names.fakePng}`, true],
    [`assets/${HOSTILE.names.fakePng}`, false],
    [`assets/${HOSTILE.names.realPng}`, true],
    [`assets/${HOSTILE.names.realPng}`, false],
  ] as const) {
    const response = await request.get(rawUrl(path, inline));
    const label = `${path} inline=${String(inline)}`;
    expect(response.status(), label).toBe(200);
    const headers = response.headers();
    expect(headers["x-content-type-options"], label).toBe("nosniff");
    const csp = headers["content-security-policy"] ?? "";
    expect(csp, label).toContain("sandbox");
    expect(csp, label).toContain("default-src 'none'");
    const disposition = headers["content-disposition"] ?? "";
    if (/^inline/.test(disposition)) {
      // Inline is only for bytes verified to be an image, with the type the name claims.
      expect(inline, `${label} served inline without asking`).toBe(true);
      expect(headers["content-type"], label).toMatch(/^image\/(svg\+xml|png)$/);
    } else {
      expect(disposition, label).toMatch(/^attachment/);
      expect(headers["content-type"], label).toBe("application/octet-stream");
    }
  }
  // The fake PNG is never verified as an image, whatever is asked.
  const fake = await request.get(rawUrl(`assets/${HOSTILE.names.fakePng}`, true));
  expect(fake.headers()["content-disposition"]).toMatch(/^attachment/);
  const real = await request.get(rawUrl(`assets/${HOSTILE.names.realPng}`, true));
  expect(real.headers()["content-disposition"]).toMatch(/^inline/);
  expect(real.headers()["content-type"]).toBe("image/png");

  // Top level in a tab of their own: the way an attacker would want them opened.
  const tab = await d.newTestPage();
  await tab.goto(rawUrl(`assets/${HOSTILE.names.svg}`, true)).catch(() => undefined);
  await tab.waitForTimeout(1500);
  clean(d, "svg raw top-level inline=1");

  for (const [path, inline] of [
    [`assets/${HOSTILE.names.svg}`, false],
    [`assets/${HOSTILE.names.fakePng}`, true],
    [`assets/${HOSTILE.names.fakePng}`, false],
  ] as const) {
    const download = tab.waitForEvent("download", { timeout: 10_000 }).catch(() => null);
    await tab.goto(rawUrl(path, inline)).catch(() => undefined);
    await download;
    await tab.waitForTimeout(500);
    clean(d, `${path} raw top-level inline=${String(inline)}`);
  }
  await tab.close();
});
