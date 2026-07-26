import { expect, test } from "@playwright/test";

test.describe("amber docker smoke", () => {
  test.skip(
    true,
    "TODO: enable once the import, sync, export, and git remote flows are implemented.",
  );

  test("imports a repo, syncs it, exports a zip, and serves a read-only clone", async ({
    page,
  }) => {
    // TODO: import a small repo on the Import page, wait for the first sync to
    // succeed on the Repos page, download a zip export, enable the git remote,
    // clone from the container, and assert that a push is rejected.
    await page.goto("/");
    await expect(page).toHaveTitle(/Amber/);
  });
});
