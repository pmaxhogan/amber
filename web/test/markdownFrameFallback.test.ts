import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import MarkdownFrame from "../src/components/MarkdownFrame.vue";
import { flush } from "./helpers/dom.ts";
import { mountGlobals } from "./helpers/mount.ts";

/*
 * WebKit does not run the parent's listeners on a frame document that may
 * not run script, so links inside the frame are inert there and the
 * component lists them itself. The frame helper is wrapped to report that,
 * and DOMPurify is a pass-through fake for the reasons given in
 * MarkdownFrame.test.ts.
 */
vi.mock("dompurify", () => {
  const instance = {
    isSupported: true,
    sanitize(html: string): DocumentFragment {
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
      const fragment = doc.createDocumentFragment();
      while (doc.body.firstChild !== null) fragment.appendChild(doc.body.firstChild);
      Object.defineProperty(fragment, "ownerDocument", { value: doc });
      return fragment;
    },
  };
  return { default: () => instance };
});

vi.mock("../src/lib/markdown/frame.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/markdown/frame.ts")>();
  return {
    ...original,
    mountMarkdownFrame: (
      ...args: Parameters<typeof original.mountMarkdownFrame>
    ): ReturnType<typeof original.mountMarkdownFrame> => {
      const [container, html, options] = args;
      const mounted = original.mountMarkdownFrame(container, html, {
        ...options,
        onClickHandling: () => options.onClickHandling?.(false),
      });
      return mounted;
    },
  };
});

const COMMIT = "d".repeat(40);

describe("MarkdownFrame link list fallback", () => {
  it("lists tree and external links when clicks in the frame cannot be handled", async () => {
    const wrapper = mount(MarkdownFrame, {
      props: {
        source:
          "[next](../next.md) [site](https://example.com/a) [bad](javascript:alert(1)) " +
          "[![logo](https://img.example/x.png)](https://example.com/b) " +
          "[Link \u202Egnp.exe](https://xn--80ak6aa92e.com/) [mail](mailto:a@b.test)",
        repoId: 2,
        commit: COMMIT,
        filePath: "docs/README.md",
      },
      global: mountGlobals(),
      attachTo: document.body,
    });
    for (let i = 0; i < 20 && !wrapper.find(".markdown-frame-links").exists(); i += 1) {
      await flush(1);
    }
    const list = wrapper.find(".markdown-frame-links");
    expect(list.exists()).toBe(true);
    const button = list.find("button");
    expect(button.text()).toBe("next");
    await button.trigger("click");
    expect(wrapper.emitted("navigate")).toEqual([["next.md"]]);
    const anchors = list.findAll("a");
    expect(anchors.map((a) => [a.text(), a.attributes("href"), a.attributes("rel")])).toEqual([
      ["site", "https://example.com/a", "noopener noreferrer nofollow"],
      ["[image: logo]", "https://example.com/b", "noopener noreferrer nofollow"],
      ["Link gnp.exe", "https://xn--80ak6aa92e.com/", "noopener noreferrer nofollow"],
      ["mail", "mailto:a@b.test", "noopener noreferrer nofollow"],
    ]);
    // The destination is shown next to each external link, in ASCII form.
    expect(list.findAll(".markdown-frame-link-host").map((span) => span.text())).toEqual([
      "(example.com)",
      "(example.com)",
      "(xn--80ak6aa92e.com)",
      "(a@b.test)",
    ]);
    expect(list.text()).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(list.text()).not.toContain("javascript");
    wrapper.unmount();
  });
});
