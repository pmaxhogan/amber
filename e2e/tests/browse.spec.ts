import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { RICH } from "./localGitServer.ts";

/**
 * The Browse tab against real backups: git repositories built on the fly,
 * served from loopback, imported and synced by the built server, then driven
 * through the real UI in Chromium.
 */
test.describe.configure({ mode: "serial" });

const REMOTE_HOST = "remote-badge.invalid";

async function openDrawer(page: Page, displayName: string): Promise<void> {
  await page.goto("/");
  await page.locator(".repo-cell__name", { hasText: displayName }).first().click();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
}

async function openBrowse(page: Page, displayName: string): Promise<void> {
  await openDrawer(page, displayName);
  await page.getByRole("tab", { name: "Browse" }).click();
}

const frame = (page: Page) => page.frameLocator("iframe[sandbox]");

test("browse is the last tab and renders the root listing and README in a sandboxed frame", async ({
  page,
  browseRepos,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await openBrowse(page, browseRepos.rich.displayName);

  const tabs = page.getByRole("tab");
  await expect(tabs.last()).toHaveText("Browse");

  const list = page.locator(".file-list");
  for (const name of ["docs", "src", "assets", "README.md", "data.bin", "link-to-guide"]) {
    await expect(list.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }

  const iframe = page.locator("iframe[sandbox]");
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");

  const body = frame(page);
  await expect(body.getByRole("heading", { name: "Fixture Title" })).toBeVisible();
  await expect(body.getByRole("table")).toBeVisible();
  await expect(body.getByText("centered html paragraph")).toBeVisible();

  // The in-repo images load from the raw endpoint and are really decoded.
  const rawImages = body.locator(
    `img[src*="/api/repos/${String(browseRepos.rich.id)}/browse/raw"]`,
  );
  await expect(rawImages).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect
      .poll(() =>
        rawImages.nth(index).evaluate((img: { naturalWidth: number }) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
  }

  // The remote image is replaced by a placeholder and never requested.
  await expect(body.getByText("[image: remote badge]")).toBeVisible();
  expect(requests.filter((url) => url.includes(REMOTE_HOST))).toEqual([]);
  expect(requests.some((url) => url.includes("/browse/raw"))).toBe(true);
});

test("relative links in the README open the directory or file; external links stay out", async ({
  page,
  browseRepos,
}) => {
  await openBrowse(page, browseRepos.rich.displayName);
  const body = frame(page);
  await expect(body.getByRole("heading", { name: "Fixture Title" })).toBeVisible();

  const startUrl = page.url();
  const iframeSrcdoc = await page.locator("iframe[sandbox]").getAttribute("srcdoc");

  // An external link opens elsewhere (a popup, if the browser allows it) and
  // leaves both the page and the frame where they were.
  const popup = page.waitForEvent("popup", { timeout: 3_000 }).catch(() => null);
  await body.getByRole("link", { name: "an external link" }).click();
  const opened = await popup;
  await opened?.close().catch(() => undefined);
  expect(page.url()).toBe(startUrl);
  await expect(body.getByRole("heading", { name: "Fixture Title" })).toBeVisible();
  expect(await page.locator("iframe[sandbox]").getAttribute("srcdoc")).toBe(iframeSrcdoc);

  await body.getByRole("link", { name: "the docs directory" }).click();
  const crumbs = page.getByRole("navigation", { name: "Path" });
  await expect(crumbs).toContainText("docs");
  await expect(frame(page).getByRole("heading", { name: "Docs Title" })).toBeVisible();
  await expect(
    page.locator(".file-list").getByRole("button", { name: /^guide\.md/ }),
  ).toBeVisible();

  // Back to the root, then the markdown file link.
  await crumbs.getByRole("button", { name: browseRepos.rich.displayName }).click();
  await frame(page).getByRole("link", { name: "the guide" }).click();
  await expect(page.locator(".file-view__name")).toHaveText("guide.md");
  await expect(frame(page).getByRole("heading", { name: "Guide Title" })).toBeVisible();
});

test("file view: line numbers, binary, symlink and the download link", async ({
  page,
  browseRepos,
}) => {
  await openBrowse(page, browseRepos.rich.displayName);
  const list = page.locator(".file-list");

  await list.getByRole("button", { name: /^src/ }).click();
  await list.getByRole("button", { name: /^app\.ts/ }).click();
  await expect(page.locator(".file-view__name")).toHaveText("app.ts");
  const code = page.locator(".code-view");
  await expect(code).toBeVisible();
  const gutter = (await code.locator(".code-view__gutter").textContent()) ?? "";
  const numbers = gutter
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  expect(numbers.slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
  expect(numbers.length).toBeGreaterThanOrEqual(6);
  await expect(code.locator(".code-view__code")).toContainText("export const answer = 42;");
  await expect(code.locator(".code-view__code")).toContainText("export const added = true;");

  const download = page.locator("a.file-view__download");
  const href = await download.getAttribute("href");
  expect(href).toContain("/browse/raw");
  const response = await page.request.get(new URL(href ?? "", page.url()).href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toMatch(/^attachment/);
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");

  // Binary: no inline rendering, just the download.
  await page
    .getByRole("navigation", { name: "Path" })
    .getByRole("button", {
      name: browseRepos.rich.displayName,
    })
    .click();
  await list.getByRole("button", { name: /^data\.bin/ }).click();
  await expect(page.locator(".file-view__note")).toContainText("Binary file");
  await expect(page.locator(".code-view")).toHaveCount(0);
  await expect(page.locator("a.file-view__download")).toBeVisible();

  // A symlink shows where it points.
  await page
    .getByRole("navigation", { name: "Path" })
    .getByRole("button", {
      name: browseRepos.rich.displayName,
    })
    .click();
  await list.getByRole("button", { name: /^link-to-guide/ }).click();
  await expect(page.locator(".file-view__note")).toContainText("Symbolic link to");
  await expect(page.locator(".file-view__note")).toContainText(RICH.symlinkTarget);
});

test("history lists commits newest first, shows diffs and renames", async ({
  page,
  browseRepos,
}) => {
  await openBrowse(page, browseRepos.rich.displayName);
  await page
    .getByRole("group", { name: "What to show" })
    .getByRole("button", { name: "History" })
    .click();

  const subjects = page.locator(".history-pane__subject");
  await expect(subjects).toHaveText(["modify app", "rename main to app", "initial import"]);

  // The modification: one line added, none removed.
  await subjects.nth(0).click();
  const file = page.locator(".diff-file").first();
  await expect(file.locator(".diff-file__path")).toContainText("src/app.ts");
  await expect(file.locator(".diff-file__plus")).toHaveText("+1");
  await expect(file.locator(".diff-file__minus")).toHaveText("-0");
  await expect(
    file.locator(".diff-line").filter({ hasText: "export const added = true;" }),
  ).toBeVisible();

  // The rename is shown as one, with both names.
  await page.getByRole("button", { name: "Back to history" }).click();
  await subjects.nth(1).click();
  const renamed = page.locator(".diff-file").first();
  await expect(renamed.locator(".diff-file__status")).toHaveText("renamed");
  await expect(renamed.locator(".diff-file__path")).toContainText("src/main.ts");
  await expect(renamed.locator(".diff-file__path")).toContainText("src/app.ts");

  // The root commit adds every file.
  await page.getByRole("button", { name: "Back to history" }).click();
  await subjects.nth(2).click();
  await expect(page.locator(".diff-file__status").first()).toHaveText("added");
  await expect(page.locator(".commit-view__minus")).toContainText("-0");
});

test("the ref picker lists branches and tags, and picking a branch changes the listing", async ({
  page,
  browseRepos,
}) => {
  await openBrowse(page, browseRepos.rich.displayName);
  const list = page.locator(".file-list");
  await expect(list.getByRole("button", { name: /^feature-only\.txt/ })).toHaveCount(0);

  const picker = page.locator(".ref-picker__button");
  await expect(picker).toBeEnabled();
  await expect(picker).toContainText("main");
  await picker.click();

  const options = page.getByRole("listbox", { name: "Branches" }).getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.filter({ hasText: RICH.featureBranch })).toHaveCount(1);
  await expect(options.filter({ hasText: /^main/ })).toHaveCount(1);

  await page.getByRole("button", { name: /^Tags \(2\)/ }).click();
  const tags = page.getByRole("listbox", { name: "Tags" }).getByRole("option");
  await expect(tags).toHaveCount(2);
  await expect(tags.filter({ hasText: RICH.lightTag })).toHaveCount(1);
  await expect(tags.filter({ hasText: RICH.annotatedTag })).toHaveCount(1);

  await page.getByRole("button", { name: /^Branches/ }).click();
  await page
    .getByRole("listbox", { name: "Branches" })
    .getByRole("option", { name: RICH.featureBranch })
    .click();
  await expect(picker).toContainText(RICH.featureBranch);
  await expect(list.getByRole("button", { name: /^feature-only\.txt/ })).toBeVisible();
});

test("the jump input takes a short sha and a tag, and explains an unknown name", async ({
  page,
  browseRepos,
}) => {
  await openBrowse(page, browseRepos.rich.displayName);
  const jump = page.getByRole("textbox", { name: "Jump to a branch, tag or commit" });
  const picker = page.locator(".ref-picker__button");

  await jump.fill(browseRepos.rich.firstSha);
  await jump.press("Enter");
  await expect(picker).toContainText(browseRepos.rich.firstSha);
  // At the first commit the source file still has its original name.
  await page.locator(".file-list").getByRole("button", { name: /^src/ }).click();
  await expect(page.locator(".file-list").getByRole("button", { name: /^main\.ts/ })).toBeVisible();

  await jump.fill(RICH.annotatedTag);
  await jump.press("Enter");
  await expect(picker).toContainText(RICH.annotatedTag);

  await jump.fill("no-such-thing-anywhere");
  await jump.press("Enter");
  await expect(page.locator(".rev-jump__message")).toContainText("is not in this backup");
  // The view stays where it was.
  await expect(picker).toContainText(RICH.annotatedTag);
});

test("a single-ref backup disables the picker, explains why, and still jumps", async ({
  page,
  browseRepos,
}) => {
  await openBrowse(page, browseRepos.single.displayName);

  const picker = page.locator(".ref-picker__button");
  await expect(picker).toBeDisabled();
  const tip = (await page.locator(".ref-picker__anchor").getAttribute("title")) ?? "";
  expect(tip).toContain("only holds one ref");
  expect(tip).toContain("shallow backup");
  await expect(page.locator("#ref-picker-only-one")).toContainText("only holds one ref");

  const jump = page.getByRole("textbox", { name: "Jump to a branch, tag or commit" });
  await jump.fill("main");
  await jump.press("Enter");
  // The input empties once the jump has resolved; typing before that would be wiped.
  await expect(jump).toHaveValue("");
  await expect(page.locator(".rev-jump__message")).toHaveCount(0);
  await expect(
    page.locator(".file-list").getByRole("button", { name: /^notes\.txt/ }),
  ).toBeVisible();

  await jump.fill("no-such-thing-anywhere");
  await jump.press("Enter");
  await expect(page.locator(".rev-jump__message")).toContainText("is not in this backup");
});

test("the maximize button widens the drawer to the viewport and restores it", async ({
  page,
  browseRepos,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDrawer(page, browseRepos.single.displayName);

  const drawer = page.locator(".repo-drawer");
  const widthOf = async (): Promise<number> => (await drawer.boundingBox())?.width ?? 0;

  await expect.poll(widthOf).toBeLessThan(1400);
  const normal = await widthOf();

  await page.getByRole("button", { name: "Maximize" }).click();
  await expect.poll(widthOf).toBe(1400);
  await expect(page.getByRole("button", { name: "Restore" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "Restore" }).click();
  await expect.poll(widthOf).toBe(normal);
  await expect(page.getByRole("button", { name: "Maximize" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // A narrow viewport has no room to grow into, so there is no button.
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 800, height: 900 });
  await openDrawer(page, browseRepos.single.displayName);
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Maximize|Restore)$/ })).toHaveCount(0);
});

test("an inline SVG is served with a sandboxing, script-free content security policy", async ({
  request,
  browseRepos,
}) => {
  const id = browseRepos.rich.id;
  const refs = await request.get(`/api/repos/${String(id)}/browse/refs`);
  expect(refs.status()).toBe(200);
  const head = ((await refs.json()) as { head: { oid: string } }).head.oid;

  const query = new URLSearchParams({ rev: head, path: "assets/logo.svg", inline: "1" });
  const svg = await request.get(`/api/repos/${String(id)}/browse/raw?${query.toString()}`);
  expect(svg.status()).toBe(200);
  expect(svg.headers()["content-type"]).toContain("image/svg+xml");
  const csp = svg.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("sandbox");
  expect(csp).toContain("default-src 'none'");
  expect(svg.headers()["x-content-type-options"]).toBe("nosniff");
});
