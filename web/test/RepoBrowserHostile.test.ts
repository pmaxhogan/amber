import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountBrowser, openEntry, press } from "./helpers/browseMount.ts";
import { flush } from "./helpers/dom.ts";
import {
  makeBlob,
  makeBrowseApi,
  makeCommitDetail,
  makeDiffFile,
  makeEntry,
  makeRefs,
  makeSummary,
  makeTree,
  oid,
} from "./helpers/browseStubs.ts";

vi.mock("../src/components/MarkdownFrame.vue", async () => {
  const { MarkdownFrameStub: stub } = await import("./helpers/markdownFrameStub.ts");
  return { default: stub };
});

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Names, paths, messages and file text out of a repository are attacker
 * controlled. Each must show up as the literal characters and never as markup.
 */

const IMG = "<img src=x onerror=alert(1)>";
const SCRIPT = '"><script>alert(1)</script>';
const SVG = "<svg onload=alert(1)>";

function noInjectedElements(wrapper: Awaited<ReturnType<typeof mountBrowser>>): void {
  // The only img the browser may ever make is the file viewer's own.
  expect(wrapper.find("img").exists()).toBe(false);
  expect(wrapper.find("script").exists()).toBe(false);
  expect(wrapper.find("svg[onload]").exists()).toBe(false);
  expect(wrapper.find("[onerror]").exists()).toBe(false);
  expect(wrapper.find("[onload]").exists()).toBe(false);
}

describe("hostile repository content", () => {
  it("prints a file name as text", async () => {
    const wrapper = await mountBrowser(
      makeBrowseApi({
        contents: { "": makeTree([makeEntry({ name: IMG, path: IMG })]) },
      }),
    );
    expect(wrapper.find(".file-list__name").text()).toBe(IMG);
    noInjectedElements(wrapper);
  });

  it("prints a path in the breadcrumb and in the history chip as text", async () => {
    const dir = makeEntry({ name: IMG, path: IMG, type: "tree", size: null });
    const api = makeBrowseApi({
      commits: [],
      contents: {
        "": makeTree([dir]),
        [IMG]: makeTree([], { path: IMG }),
      },
    });
    const wrapper = await mountBrowser(api);
    await openEntry(wrapper, IMG);
    expect(wrapper.find(".crumbs").text()).toContain(IMG);
    noInjectedElements(wrapper);

    await press(wrapper, "History");
    expect(wrapper.find(".history-pane__chip").text()).toContain(IMG);
    noInjectedElements(wrapper);
  });

  it("prints a branch name as text in the picker, the list and the jump message", async () => {
    const refs = makeRefs({
      head: { oid: oid("a"), kind: "branch", name: SCRIPT },
      rows: [{ kind: "branch", name: SCRIPT, oid: oid("a") }],
      branchCount: 2,
    });
    const api = makeBrowseApi({ refs });
    const wrapper = await mountBrowser(api);
    expect(wrapper.find("button.ref-picker__button").text()).toBe(SCRIPT);

    await wrapper.find("button.ref-picker__button").trigger("click");
    await press(wrapper, "Branches (2)");
    expect(wrapper.find(".ref-picker__name").text()).toBe(SCRIPT);

    const input = wrapper.find(".rev-jump input");
    await input.setValue(IMG);
    await input.trigger("keydown", { key: "Enter" });
    await press(wrapper, "Branches (2)");
    expect(wrapper.find(".rev-jump__message").text()).toContain(IMG);
    noInjectedElements(wrapper);
  });

  it("prints file text and an svg's source as text", async () => {
    const api = makeBrowseApi({
      contents: {
        "": makeTree([makeEntry({ name: "x.html" }), makeEntry({ name: "y.svg" })]),
        "x.html": makeBlob({ path: "x.html", text: `${IMG}<script>alert(1)</script>\n` }),
        "y.svg": makeBlob({ path: "y.svg", view: "image", text: SVG }),
      },
    });
    const wrapper = await mountBrowser(api);
    await openEntry(wrapper, "x.html");
    expect(wrapper.find(".code-view__code").text()).toContain(IMG);
    noInjectedElements(wrapper);

    await press(wrapper, "node");
    await openEntry(wrapper, "y.svg");
    await press(wrapper, "Source");
    expect(wrapper.find(".code-view__code").text()).toBe(SVG);
    noInjectedElements(wrapper);
  });

  it("prints a symlink target, an LFS pointer and a plain README as text", async () => {
    const api = makeBrowseApi({
      contents: {
        "": makeTree([makeEntry({ name: "link", type: "symlink" }), makeEntry({ name: "README" })]),
        link: makeBlob({ path: "link", symlink: true, text: IMG }),
        README: makeBlob({ path: "README", text: `${IMG}\n` }),
      },
    });
    const wrapper = await mountBrowser(api);
    expect(wrapper.find(".readme__plain").text()).toBe(IMG);
    noInjectedElements(wrapper);

    await openEntry(wrapper, "link");
    expect(wrapper.find(".file-view__note").text()).toContain(IMG);
    noInjectedElements(wrapper);
  });

  it("prints commit subjects, bodies, people and patch lines as text", async () => {
    const detail = makeCommitDetail({
      oid: oid("d"),
      subject: IMG,
      body: `${SCRIPT}\n${SVG}`,
      authorName: IMG,
      authorEmail: `${SCRIPT}@example.com`,
      files: [
        makeDiffFile({
          path: IMG,
          oldPath: SCRIPT,
          status: "renamed",
          patch: `@@ -1 +1 @@\n-${IMG}\n+${SCRIPT}\n ${SVG}\n`,
        }),
      ],
    });
    const api = makeBrowseApi({
      commits: [makeSummary({ oid: oid("d"), subject: IMG, authorName: IMG })],
      commitDetails: { [oid("d")]: detail },
    });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    expect(wrapper.find(".history-pane__subject").text()).toBe(IMG);
    noInjectedElements(wrapper);

    await wrapper.find(".history-pane__subject").trigger("click");
    await flush();

    expect(wrapper.find(".commit-view__subject").text()).toBe(IMG);
    expect(wrapper.find(".commit-view__body").text()).toContain(SVG);
    expect(wrapper.find(".diff-file__path").text()).toContain(`${SCRIPT} -> ${IMG}`);
    expect(wrapper.findAll(".diff-line__text").map((line) => line.text())).toEqual([
      "@@ -1 +1 @@",
      `-${IMG}`,
      `+${SCRIPT}`,
      SVG,
    ]);
    noInjectedElements(wrapper);
  });

  it("only ever binds urls built from the repo id, commit and path", async () => {
    const api = makeBrowseApi({
      contents: {
        "": makeTree([makeEntry({ name: "javascript:alert(1)" })]),
        "javascript:alert(1)": makeBlob({ path: "javascript:alert(1)", text: "x" }),
      },
    });
    const wrapper = await mountBrowser(api);
    await openEntry(wrapper, "javascript:alert(1)");
    const hrefs = wrapper.findAll("a").map((anchor) => anchor.attributes("href"));
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toMatch(/^\/api\/repos\/1\/browse\/raw\?/);
  });
});
