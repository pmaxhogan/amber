import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../src/api/client.ts";
import { MarkdownFrameStub } from "./helpers/markdownFrameStub.ts";
import { mountBrowser, openEntry, press } from "./helpers/browseMount.ts";
import { flush } from "./helpers/dom.ts";
import {
  HEAD_OID,
  makeBlob,
  makeBrowseApi,
  makeCommitDetail,
  makeSummary,
  makeEntry,
  makeRefs,
  makeTree,
  oid,
} from "./helpers/browseStubs.ts";

vi.mock("../src/components/MarkdownFrame.vue", async () => {
  const { MarkdownFrameStub: stub } = await import("./helpers/markdownFrameStub.ts");
  return { default: stub };
});

const toast = { success: vi.fn(), info: vi.fn(), warn: vi.fn(), failure: vi.fn() };
vi.mock("../src/lib/toast.ts", () => ({ useToaster: () => toast }));

beforeEach(() => {
  vi.clearAllMocks();
});

const ROOT = makeTree([
  makeEntry({ name: "docs", path: "docs", type: "tree", size: null, mode: "040000" }),
  makeEntry({ name: "src", path: "src", type: "tree", size: null, mode: "040000" }),
  makeEntry({ name: "index.ts", size: 2048 }),
  makeEntry({ name: "link", type: "symlink", mode: "120000", size: 9 }),
  makeEntry({ name: "vendor", type: "submodule", mode: "160000", size: null, oid: oid("9") }),
]);

const DOCS = makeTree([makeEntry({ name: "guide.md", path: "docs/guide.md" })], {
  path: "docs",
});

function rows(wrapper: Awaited<ReturnType<typeof mountBrowser>>): string[] {
  return wrapper.findAll(".file-list__name").map((name) => name.text());
}

describe("files mode: listing", () => {
  it("opens on the tip of the default branch and lists the root", async () => {
    const api = makeBrowseApi({ contents: { "": ROOT } });
    const wrapper = await mountBrowser(api);

    expect(vi.mocked(api.browseContents).mock.calls[0]?.slice(0, 3)).toEqual([1, HEAD_OID, ""]);
    expect(rows(wrapper)).toEqual(["docs", "src", "index.ts", "link", "vendor"]);
    expect(wrapper.text()).toContain("2.00 KB");
    expect(wrapper.find("button.ref-picker__button").text()).toBe("main");
    // The root has no ".." row.
    expect(rows(wrapper)).not.toContain("..");
  });

  it("names the repository at the root of the breadcrumb", async () => {
    const wrapper = await mountBrowser(makeBrowseApi({ contents: { "": ROOT } }));
    expect(wrapper.find(".crumbs").text()).toBe("node");
  });

  it("goes into a directory and back out through .. and the breadcrumb", async () => {
    const api = makeBrowseApi({ contents: { "": ROOT, docs: DOCS } });
    const wrapper = await mountBrowser(api);

    await press(wrapper, "docs");
    expect(vi.mocked(api.browseContents).mock.calls.at(-1)?.slice(0, 3)).toEqual([
      1,
      HEAD_OID,
      "docs",
    ]);
    expect(rows(wrapper)).toEqual(["..", "guide.md"]);
    expect(wrapper.find(".crumbs").text()).toBe("node/docs");

    await press(wrapper, "..");
    expect(rows(wrapper)).toContain("index.ts");

    await press(wrapper, "docs");
    await press(wrapper, "node");
    expect(rows(wrapper)).toContain("index.ts");
  });

  it("shows a submodule with its short id and does not make it a link", async () => {
    const api = makeBrowseApi({ contents: { "": ROOT } });
    const wrapper = await mountBrowser(api);
    const callsBefore = vi.mocked(api.browseContents).mock.calls.length;

    const row = wrapper.findAll(".file-list__row").find((r) => r.text().includes("vendor"));
    expect(row?.element.tagName).toBe("DIV");
    expect(row?.text()).toContain("submodule 9999999");

    await row?.trigger("click");
    await flush();
    expect(vi.mocked(api.browseContents).mock.calls).toHaveLength(callsBefore);
  });

  it("notes a truncated listing and an empty directory", async () => {
    const wrapper = await mountBrowser(
      makeBrowseApi({
        contents: { "": makeTree([makeEntry({ name: "a" })], { truncated: true }) },
      }),
    );
    expect(wrapper.text()).toContain("only the first 1 entries are shown");

    const empty = await mountBrowser(makeBrowseApi({ contents: { "": makeTree([]) } }));
    expect(empty.text()).toContain("This directory is empty.");
  });

  it("shows a friendly page when a path is not at this commit", async () => {
    const api = makeBrowseApi({ contents: { "": ROOT } });
    const wrapper = await mountBrowser(api);
    // "src" is listed but the stub holds no contents for it, so it 404s.
    await press(wrapper, "src");
    expect(wrapper.text()).toContain("Not found at this commit");
    await press(wrapper, "Go to the top");
    expect(rows(wrapper)).toContain("index.ts");
  });
});

describe("files mode: README", () => {
  const readmeEntry = makeEntry({ name: "readme.md", size: 30 });

  it("shows a markdown README under the list and hands it to the renderer", async () => {
    const api = makeBrowseApi({
      contents: {
        "": makeTree([readmeEntry, makeEntry({ name: "a.txt" })]),
        "readme.md": makeBlob({
          path: "readme.md",
          view: "markdown",
          text: "# Hello\n",
        }),
      },
    });
    const wrapper = await mountBrowser(api);

    const frame = wrapper.findComponent(MarkdownFrameStub);
    expect(frame.exists()).toBe(true);
    expect(frame.props()).toEqual({
      source: "# Hello\n",
      repoId: 1,
      commit: HEAD_OID,
      filePath: "readme.md",
    });
    expect(wrapper.find(".readme__title").text()).toBe("readme.md");
  });

  it("shows any other README as plain text", async () => {
    const api = makeBrowseApi({
      contents: {
        "": makeTree([makeEntry({ name: "README" })]),
        README: makeBlob({ path: "README", view: "text", text: "plain *words* <b>x</b>\n" }),
      },
    });
    const wrapper = await mountBrowser(api);

    expect(wrapper.findComponent(MarkdownFrameStub).exists()).toBe(false);
    expect(wrapper.find(".readme__plain").text()).toBe("plain *words* <b>x</b>");
    expect(wrapper.find(".readme__plain b").exists()).toBe(false);
  });

  it("leaves the listing up when the README fails to load", async () => {
    const api = makeBrowseApi({ contents: { "": makeTree([readmeEntry]) } });
    const wrapper = await mountBrowser(api);
    expect(wrapper.find(".readme").exists()).toBe(false);
    expect(rows(wrapper)).toEqual(["readme.md"]);
  });

  it("does not show a README that is too large", async () => {
    const api = makeBrowseApi({
      contents: {
        "": makeTree([readmeEntry]),
        "readme.md": makeBlob({ path: "readme.md", view: "markdown", text: null, tooLarge: true }),
      },
    });
    const wrapper = await mountBrowser(api);
    expect(wrapper.find(".readme").exists()).toBe(false);
  });

  it("opens the README of the directory being viewed", async () => {
    const api = makeBrowseApi({
      contents: {
        "": ROOT,
        docs: makeTree([makeEntry({ name: "README.md", path: "docs/README.md" })], {
          path: "docs",
        }),
        "docs/README.md": makeBlob({ path: "docs/README.md", view: "markdown", text: "docs" }),
      },
    });
    const wrapper = await mountBrowser(api);
    expect(wrapper.find(".readme").exists()).toBe(false);
    await press(wrapper, "docs");
    expect(wrapper.findComponent(MarkdownFrameStub).props("filePath")).toBe("docs/README.md");
  });
});

describe("files mode: a file", () => {
  async function openFile(blob: ReturnType<typeof makeBlob>, extra = {}) {
    const api = makeBrowseApi({
      contents: {
        "": makeTree([makeEntry({ name: blob.name, path: blob.path })]),
        [blob.path]: blob,
      },
      ...extra,
    });
    const wrapper = await mountBrowser(api);
    await openEntry(wrapper, blob.name);
    return { wrapper, api };
  }

  it("shows text with line numbers and a download link", async () => {
    const { wrapper } = await openFile(makeBlob({ path: "a.ts", text: "one\ntwo\nthree\n" }));
    expect(wrapper.find(".code-view__gutter").text()).toBe("1\n2\n3");
    expect(wrapper.find(".code-view__code").text()).toBe("one\ntwo\nthree");
    // Two text nodes, not an element per line.
    expect(wrapper.findAll(".code-view *")).toHaveLength(3);

    const download = wrapper.find("a[download]");
    expect(download.attributes("href")).toBe(`/api/repos/1/browse/raw?rev=${HEAD_OID}&path=a.ts`);
    expect(wrapper.find(".file-view__head").text()).toContain("a.ts");
    expect(wrapper.find(".file-view__head").text()).toContain("42 B");
  });

  it("opens the history of the file from its header", async () => {
    const { wrapper, api } = await openFile(makeBlob({ path: "src/a.ts" }), {
      commits: [],
    });
    await press(wrapper, "History");
    expect(vi.mocked(api.browseCommits).mock.calls[0]?.slice(0, 2)).toEqual([
      1,
      { rev: HEAD_OID, path: "src/a.ts" },
    ]);
    expect(wrapper.find(".history-pane__chip").text()).toContain("src/a.ts");
  });

  it("shows markdown rendered by default and offers the source", async () => {
    const { wrapper } = await openFile(
      makeBlob({ path: "notes.md", view: "markdown", text: "# Title\n\nbody\n" }),
    );
    const frame = wrapper.findComponent(MarkdownFrameStub);
    expect(frame.props()).toMatchObject({ source: "# Title\n\nbody\n", filePath: "notes.md" });

    await press(wrapper, "Source");
    expect(wrapper.findComponent(MarkdownFrameStub).exists()).toBe(false);
    expect(wrapper.find(".code-view__gutter").text()).toBe("1\n2\n3");

    await press(wrapper, "Preview");
    expect(wrapper.findComponent(MarkdownFrameStub).exists()).toBe(true);
  });

  it("shows a raster image through the raw endpoint only", async () => {
    const { wrapper } = await openFile(
      makeBlob({ path: "img/logo.png", view: "image", text: null, size: 5000 }),
    );
    const img = wrapper.find(".file-view__image img");
    expect(img.attributes("src")).toBe(
      `/api/repos/1/browse/raw?rev=${HEAD_OID}&path=img%2Flogo.png&inline=1`,
    );
    expect(img.attributes("alt")).toBe("logo.png");
    expect(wrapper.text()).not.toContain("Source");
  });

  it("offers the source of an svg", async () => {
    const { wrapper } = await openFile(
      makeBlob({ path: "i.svg", view: "image", text: "<svg onload=alert(1)></svg>" }),
    );
    expect(wrapper.find(".file-view__image img").exists()).toBe(true);
    await press(wrapper, "Source");
    expect(wrapper.find(".file-view__image").exists()).toBe(false);
    expect(wrapper.find(".code-view__code").text()).toBe("<svg onload=alert(1)></svg>");
    expect(wrapper.find("svg[onload]").exists()).toBe(false);
  });

  it("says a binary file is binary and links the download", async () => {
    const { wrapper } = await openFile(
      makeBlob({ path: "a.bin", view: "binary", text: null, size: 4096 }),
    );
    expect(wrapper.text()).toContain("Binary file, 4.00 KB");
    expect(wrapper.find("a[download]").exists()).toBe(true);
    expect(wrapper.find(".code-view").exists()).toBe(false);
  });

  it("says a large file is too large to show", async () => {
    const { wrapper } = await openFile(
      makeBlob({ path: "big.log", text: null, tooLarge: true, size: 3 * 1024 * 1024 }),
    );
    expect(wrapper.text()).toContain("too large to show here (3.00 MB)");
    expect(wrapper.find("a[download]").exists()).toBe(true);
    expect(wrapper.find(".code-view").exists()).toBe(false);
  });

  it("names the target of a symbolic link", async () => {
    const { wrapper } = await openFile(
      makeBlob({ path: "link", symlink: true, text: "../elsewhere/file.txt", size: 20 }),
    );
    expect(wrapper.find(".file-view__note").text()).toBe("Symbolic link to ../elsewhere/file.txt");
    expect(wrapper.find(".code-view").exists()).toBe(false);
  });

  it("explains a Git LFS pointer and shows the pointer text", async () => {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n";
    const { wrapper } = await openFile(
      makeBlob({ path: "model.bin", lfsPointer: true, view: "text", text: pointer }),
    );
    expect(wrapper.find(".file-view__note").text()).toContain("Git LFS pointer");
    expect(wrapper.find(".code-view__code").text()).toContain("oid sha256:abc");
  });

  it("says an empty file is empty", async () => {
    const { wrapper } = await openFile(makeBlob({ path: "empty", text: "", size: 0 }));
    expect(wrapper.text()).toContain("This file is empty.");
  });
});

describe("files mode: markdown links", () => {
  const readme = makeBlob({ path: "README.md", view: "markdown", text: "[x](a)" });

  function setup() {
    return makeBrowseApi({
      contents: {
        "": makeTree([
          makeEntry({ name: "README.md" }),
          makeEntry({ name: "docs", type: "tree", size: null }),
        ]),
        "README.md": readme,
        docs: DOCS,
        "docs/guide.md": makeBlob({ path: "docs/guide.md", view: "text", text: "guide" }),
      },
    });
  }

  it("opens a file the markdown links to", async () => {
    const api = setup();
    const wrapper = await mountBrowser(api);

    wrapper.findComponent(MarkdownFrameStub).vm.$emit("navigate", "docs/guide.md");
    await flush();

    expect(wrapper.find(".crumbs").text()).toBe("node/docs/guide.md");
    expect(wrapper.find(".code-view__code").text()).toBe("guide");
    // The probe is reused rather than fetched twice.
    const guideCalls = vi
      .mocked(api.browseContents)
      .mock.calls.filter((call) => call[2] === "docs/guide.md");
    expect(guideCalls).toHaveLength(1);
  });

  it("opens a directory the markdown links to", async () => {
    const wrapper = await mountBrowser(setup());
    wrapper.findComponent(MarkdownFrameStub).vm.$emit("navigate", "docs");
    await flush();
    expect(rows(wrapper)).toEqual(["..", "guide.md"]);
  });

  it("treats an empty path from the renderer as the root directory", async () => {
    const api = makeBrowseApi({
      contents: {
        "": ROOT,
        docs: makeTree([makeEntry({ name: "README.md", path: "docs/README.md" })], {
          path: "docs",
        }),
        "docs/README.md": makeBlob({ path: "docs/README.md", view: "markdown", text: "[up](..)" }),
      },
    });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "docs");
    expect(wrapper.find(".crumbs").text()).toBe("node/docs");

    wrapper.findComponent(MarkdownFrameStub).vm.$emit("navigate", "");
    await flush();

    expect(wrapper.find(".crumbs").text()).toBe("node");
    expect(rows(wrapper)).toContain("index.ts");
    expect(toast.warn).not.toHaveBeenCalled();
  });

  it("toasts, and stays put, when the path does not exist", async () => {
    const wrapper = await mountBrowser(setup());
    wrapper.findComponent(MarkdownFrameStub).vm.$emit("navigate", "nope/missing.md");
    await flush();

    expect(toast.warn).toHaveBeenCalledWith("Not found", expect.stringContaining("does not exist"));
    expect(wrapper.find(".crumbs").text()).toBe("node");
    expect(wrapper.findComponent(MarkdownFrameStub).exists()).toBe(true);
  });

  it("toasts other failures", async () => {
    const api = setup();
    vi.mocked(api.browseContents).mockImplementation(async (_id, _rev, path = "") => {
      if (path === "boom") throw new ApiClientError("boom", "Server fell over", 500);
      const hit = { "": makeTree([makeEntry({ name: "README.md" })]), "README.md": readme }[path];
      if (hit === undefined) throw new ApiClientError("not_found", "no", 404);
      return hit;
    });
    const wrapper = await mountBrowser(api);
    wrapper.findComponent(MarkdownFrameStub).vm.$emit("navigate", "boom");
    await flush();
    expect(toast.failure).toHaveBeenCalled();
  });
});

describe("refs and revisions", () => {
  it("jumps to a commit with the picker disabled, then browses that commit", async () => {
    const refs = makeRefs({ branchCount: 1, tagCount: 0 });
    const api = makeBrowseApi({ refs, contents: { "": ROOT } });
    vi.mocked(api.browseResolve).mockResolvedValue({
      oid: oid("7"),
      kind: "commit",
      name: null,
    });
    const wrapper = await mountBrowser(api);
    expect(wrapper.find("button.ref-picker__button").attributes("disabled")).toBeDefined();

    const input = wrapper.find(".rev-jump input");
    await input.setValue("7777777");
    await input.trigger("keydown", { key: "Enter" });
    await flush();

    expect(vi.mocked(api.browseContents).mock.calls.at(-1)?.slice(0, 3)).toEqual([1, oid("7"), ""]);
    expect(wrapper.find("button.ref-picker__button").text()).toBe("7777777");
  });

  it("shows a jump that is not in the backup without leaving the current view", async () => {
    const api = makeBrowseApi({ contents: { "": ROOT } });
    const wrapper = await mountBrowser(api);
    const input = wrapper.find(".rev-jump input");
    await input.setValue("ghost");
    await input.trigger("keydown", { key: "Enter" });
    await flush();

    expect(wrapper.find(".rev-jump [role=alert]").text()).toContain("not in this backup");
    expect(rows(wrapper)).toContain("index.ts");
  });

  it("starts over at the root of the picked ref", async () => {
    const api = makeBrowseApi({ contents: { "": ROOT, docs: DOCS } });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "docs");
    expect(wrapper.find(".crumbs").text()).toBe("node/docs");

    await wrapper.find("button.ref-picker__button").trigger("click");
    await flush();
    await wrapper.findAll("[role=option]")[1]?.trigger("click");
    await flush();

    expect(wrapper.find(".crumbs").text()).toBe("node");
    expect(vi.mocked(api.browseContents).mock.calls.at(-1)?.slice(0, 3)).toEqual([1, oid("b"), ""]);
    expect(wrapper.find("button.ref-picker__button").text()).toBe("dev");
  });

  it("downloads the tree at the current commit as a zip", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const api = makeBrowseApi({ contents: { "": ROOT } });
    const wrapper = await mountBrowser(api);

    await press(wrapper, "Download zip");

    expect(api.downloadExport).toHaveBeenCalledWith(1, "source", "zip", HEAD_OID);
    expect(createObjectURL).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("downloads the commit being viewed, not the browser's revision, in commit mode", async () => {
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn().mockReturnValue("blob:x"),
        revokeObjectURL: vi.fn(),
      }),
    );
    const api = makeBrowseApi({
      contents: { "": ROOT },
      commits: [makeSummary({ oid: oid("5"), subject: "older" })],
      commitDetails: { [oid("5")]: makeCommitDetail({ oid: oid("5"), subject: "older" }) },
    });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    await press(wrapper, "older");

    await press(wrapper, "Download zip");

    expect(api.downloadExport).toHaveBeenCalledWith(1, "source", "zip", oid("5"));
    vi.unstubAllGlobals();
  });

  it("reports a failed zip download", async () => {
    const api = makeBrowseApi(
      { contents: { "": ROOT } },
      { downloadExport: vi.fn().mockRejectedValue(new ApiClientError("boom", "no", 500)) },
    );
    const wrapper = await mountBrowser(api);
    await press(wrapper, "Download zip");
    expect(toast.failure).toHaveBeenCalledWith("Could not download the archive", expect.anything());
  });
});

describe("first load", () => {
  it("shows an empty state for a backup with no commits", async () => {
    const api = makeBrowseApi({
      refs: makeRefs({ head: null, branchCount: 0, tagCount: 0, rows: [] }),
    });
    const wrapper = await mountBrowser(api);
    expect(wrapper.text()).toContain("This backup has no commits yet.");
    expect(wrapper.find(".ref-picker").exists()).toBe(false);
    expect(api.browseContents).not.toHaveBeenCalled();
  });

  it("is friendly, not red, when the repository is not backed up yet", async () => {
    const api = makeBrowseApi(
      {},
      {
        browseRefs: vi
          .fn()
          .mockRejectedValue(new ApiClientError("not_backed_up", "No backup on disk", 409)),
      },
    );
    const wrapper = await mountBrowser(api);
    expect(wrapper.text()).toContain("Not backed up yet");
    expect(wrapper.find("[role=alert]").exists()).toBe(false);
  });

  it("shows other errors with a retry that works", async () => {
    const browseRefs = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("boom", "It broke", 500))
      .mockResolvedValue(makeRefs());
    const api = makeBrowseApi({ contents: { "": ROOT } }, { browseRefs });
    const wrapper = await mountBrowser(api);
    expect(wrapper.find("[role=alert]").text()).toContain("It broke");

    await press(wrapper, "Try again");
    expect(rows(wrapper)).toContain("index.ts");
  });

  it("shows a skeleton while the refs load", async () => {
    const api = makeBrowseApi({}, { browseRefs: vi.fn(() => new Promise(() => undefined)) });
    const wrapper = await mountBrowser(api);
    expect(wrapper.find("[aria-busy=true]").exists()).toBe(true);
  });

  it("ignores a stale answer when the user moves on", async () => {
    let release: (value: unknown) => void = () => undefined;
    const api = makeBrowseApi({ contents: { "": ROOT, docs: DOCS } });
    const real = vi.mocked(api.browseContents).getMockImplementation();
    vi.mocked(api.browseContents).mockImplementation(((id: number, rev: string, path = "") =>
      path === "docs"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : real?.(id, rev, path)) as never);
    const wrapper = await mountBrowser(api);

    await press(wrapper, "docs");
    await press(wrapper, "node");
    release(DOCS);
    await flush();

    expect(wrapper.find(".crumbs").text()).toBe("node");
    expect(rows(wrapper)).toContain("index.ts");
  });
});
