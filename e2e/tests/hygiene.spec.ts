import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * A browser console that stays quiet. Every route is visited, then a repo
 * drawer is opened with a rendered README and every tab is clicked through,
 * while anything noisy is collected: console errors, uncaught page errors and
 * Content Security Policy violations (from the DOM event, in every frame, and
 * from the console text). Any of them fails the test.
 */

const ROUTES = [
  "/",
  "/removed",
  "/import",
  "/accounts",
  "/account-sync",
  "/settings",
  "/git-remote",
  "/about",
];

interface Noise {
  collected: string[];
}

async function collectNoise(page: Page): Promise<Noise> {
  const collected: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" || /content security policy/i.test(text)) {
      collected.push(`console.${message.type()}: ${text} (${message.location().url})`);
    }
  });
  page.on("pageerror", (error) => collected.push(`pageerror: ${error.message}`));
  await page.exposeFunction("__amberReportCsp", (detail: string) => {
    collected.push(`securitypolicyviolation: ${detail}`);
  });
  // Runs in every frame, including the sandboxed srcdoc one.
  await page.addInitScript({
    content: `document.addEventListener("securitypolicyviolation", (event) => {
      window.__amberReportCsp?.(
        event.violatedDirective + " blocked " + event.blockedURI + " in " + event.documentURI +
          " (" + event.sample + ") at " + event.sourceFile + ":" + event.lineNumber,
      );
    });`,
  });
  return { collected };
}

test("the app document carries a content security policy", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
});

test("no console errors, page errors or CSP violations across every route and tab", async ({
  page,
  browseRepos,
}) => {
  const noise = await collectNoise(page);

  const documents: { url: string; csp: string | undefined }[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "document" && response.frame() === page.mainFrame()) {
      documents.push({
        url: response.url(),
        csp: response.headers()["content-security-policy"],
      });
    }
  });

  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator("main, #app").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
  }
  expect(documents.length).toBeGreaterThanOrEqual(ROUTES.length);
  for (const document of documents) {
    expect(document.csp, `no CSP on ${document.url}`).toContain("default-src 'self'");
  }

  // A repo drawer, every tab, with the README rendered inside Browse.
  await page.goto("/");
  await page.locator(".repo-cell__name", { hasText: browseRepos.rich.displayName }).first().click();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();

  const tabNames = await page.getByRole("tab").allTextContents();
  expect(tabNames.at(-1)).toBe("Browse");
  for (const name of tabNames) {
    await page.getByRole("tab", { name, exact: true }).click();
    await page.waitForLoadState("networkidle");
  }

  await expect(page.locator("iframe[sandbox]")).toHaveCount(1);
  await expect(
    page.frameLocator("iframe[sandbox]").getByRole("heading", { name: "Fixture Title" }),
  ).toBeVisible();
  // Let the in-repo images finish (or fail) before judging the console.
  await expect
    .poll(() =>
      page
        .frameLocator("iframe[sandbox]")
        .locator("img")
        .evaluateAll((images: { complete: boolean }[]) => images.every((img) => img.complete)),
    )
    .toBe(true);

  // History, a commit, and a file view too: they are all new surface.
  await page
    .getByRole("group", { name: "What to show" })
    .getByRole("button", { name: "History" })
    .click();
  await page.locator(".history-pane__subject").first().click();
  await expect(page.locator(".diff-file").first()).toBeVisible();
  await page.getByRole("button", { name: "Back to history" }).click();
  await page
    .getByRole("group", { name: "What to show" })
    .getByRole("button", { name: "Files" })
    .click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: /^assets/ })
    .click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: /^logo\.svg/ })
    .click();
  await expect(page.locator(".file-view__image img")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".file-view__image img")
        .evaluate((img: { naturalWidth: number }) => img.naturalWidth),
    )
    .toBeGreaterThan(0);

  expect(noise.collected).toEqual([]);
});
