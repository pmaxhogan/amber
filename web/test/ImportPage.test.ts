import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import ImportPage from "../src/pages/ImportPage.vue";
import { routes } from "../src/router/index.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import { stubApi } from "./helpers/stubApi.ts";

const PREVIEW = {
  results: [
    {
      line: "https://github.com/nodejs/node",
      lineNumber: 1,
      status: "ok" as const,
      parsed: {
        protocol: "https" as const,
        host: "github.com",
        port: null,
        path: "nodejs/node",
        username: null,
        displayName: "node",
        canonicalUrl: "https://github.com/nodejs/node",
      },
    },
    {
      line: "ghost@github.com/vuejs/core",
      lineNumber: 2,
      status: "warning" as const,
      message: "No account named ghost on github.com. Importing without an override",
      parsed: {
        protocol: "https" as const,
        host: "github.com",
        port: null,
        path: "vuejs/core",
        username: "ghost",
        displayName: "core",
        canonicalUrl: "https://github.com/vuejs/core",
      },
    },
    {
      line: "git@github.com:torvalds/linux.git",
      lineNumber: 3,
      status: "error" as const,
      message: "SSH remotes are not supported yet",
    },
  ],
  summary: { total: 3, ok: 1, warning: 1, error: 1 },
};

async function mountPage(api = stubApi({ previewImport: vi.fn().mockResolvedValue(PREVIEW) })) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/import");
  await router.isReady();
  const wrapper = mount(ImportPage, { global: mountGlobals({ api, router }) });
  await flush();
  return { wrapper, api };
}

async function previewSome(wrapper: Awaited<ReturnType<typeof mountPage>>["wrapper"]) {
  await wrapper.find("#import-text").setValue("https://github.com/nodejs/node");
  await clickButton(wrapper, "Preview");
  await flush();
}

describe("Import preview", () => {
  it("keeps Preview disabled until there is something to parse", async () => {
    const { wrapper } = await mountPage();
    expect(findButton(wrapper, "Preview")?.attributes().disabled).toBeDefined();
  });

  it("sends the raw text to the preview endpoint", async () => {
    const { wrapper, api } = await mountPage();
    await previewSome(wrapper);
    expect(api.previewImport).toHaveBeenCalledWith("https://github.com/nodejs/node");
  });

  it("renders one row per parsed line", async () => {
    const { wrapper } = await mountPage();
    await previewSome(wrapper);

    const rows = wrapper.findAll('[data-testid="import-preview"] tbody tr');
    expect(rows).toHaveLength(3);
  });

  it("labels each line with its own status", async () => {
    const { wrapper } = await mountPage();
    await previewSome(wrapper);

    const statuses = wrapper.findAll('[data-testid="import-preview"] .status');
    expect(statuses.map((element) => element.text())).toEqual(["Ready", "Warning", "Error"]);
  });

  it("colour-codes the row by status, and never by colour alone", async () => {
    const { wrapper } = await mountPage();
    await previewSome(wrapper);

    const rows = wrapper.findAll('[data-testid="import-preview"] tbody tr');
    expect(rows[0]?.classes()).toContain("import-row--ok");
    expect(rows[1]?.classes()).toContain("import-row--warning");
    expect(rows[2]?.classes()).toContain("import-row--error");
    // A text label rides along with every colour.
    expect(rows[2]?.text()).toContain("Error");
  });

  it("shows the parsed target and the account override a user prefix selected", async () => {
    const { wrapper } = await mountPage();
    await previewSome(wrapper);

    const rows = wrapper.findAll('[data-testid="import-preview"] tbody tr');
    expect(rows[0]?.text()).toContain("github.com/nodejs/node");
    expect(rows[1]?.text()).toContain("ghost");
    expect(rows[0]?.text()).toContain("forge default");
  });

  it("explains why a rejected line was rejected", async () => {
    const { wrapper } = await mountPage();
    await previewSome(wrapper);

    expect(wrapper.text()).toContain("SSH remotes are not supported yet");
  });

  it("summarizes the counts", async () => {
    const { wrapper } = await mountPage();
    await previewSome(wrapper);

    const summary = wrapper.find('[data-testid="import-preview"] .import-summary').text();
    expect(summary).toContain("1 ready");
    expect(summary).toContain("1 with warnings");
    expect(summary).toContain("1 rejected");
  });

  it("offers to import the lines that are not rejected", async () => {
    const { wrapper } = await mountPage();
    await previewSome(wrapper);

    // ok plus warning: a warning still imports, it just loses the override.
    expect(findButton(wrapper, "Import 2")).toBeDefined();
  });
});

describe("Import commit", () => {
  it("reports created, updated, and failed per line", async () => {
    const api = stubApi({
      previewImport: vi.fn().mockResolvedValue(PREVIEW),
      commitImport: vi.fn().mockResolvedValue({
        created: 1,
        updated: 1,
        failed: 1,
        results: [
          { ...PREVIEW.results[0], action: "created", repoId: 4 },
          { ...PREVIEW.results[1], action: "updated", repoId: 5 },
          { ...PREVIEW.results[2], action: "failed" },
        ],
      }),
    } as never);
    const { wrapper } = await mountPage(api);
    await previewSome(wrapper);

    await clickButton(wrapper, "Import 2");
    await flush();

    const results = wrapper.find('[data-testid="import-results"]');
    expect(results.exists()).toBe(true);
    expect(results.text()).toContain("1 created");
    const rows = results.findAll("tbody tr");
    expect(rows.map((row) => row.classes().join(" "))).toEqual([
      expect.stringContaining("import-row--created"),
      expect.stringContaining("import-row--updated"),
      expect.stringContaining("import-row--failed"),
    ]);
  });

  it("surfaces a failed request as a retryable error state", async () => {
    const api = stubApi({
      previewImport: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    } as never);
    const { wrapper } = await mountPage(api);
    await previewSome(wrapper);

    expect(wrapper.text()).toContain("The import request failed");
    expect(findButton(wrapper, "Try again")).toBeDefined();
  });
});
