import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarkdownFrame from "../src/components/MarkdownFrame.vue";
import markdownFrameSource from "../src/components/MarkdownFrame.vue?raw";
import { handleFrameClick, mountMarkdownFrame } from "../src/lib/markdown/frame.ts";
import { flush } from "./helpers/dom.ts";
import { mountGlobals } from "./helpers/mount.ts";

/*
 * happy-dom is not a browser: DOMPurify does not really clean anything here
 * and its fragment lands in the live document, which the renderer refuses
 * (see markdownRender.test.ts). So these tests swap DOMPurify for a
 * pass-through fake and only cover the component's wiring and its
 * fail-closed paths. The hostile corpus runs in Chromium and WebKit.
 */
const purify = vi.hoisted(() => ({ mode: "pass" as "pass" | "unsupported" | "throw" }));

vi.mock("dompurify", () => {
  const instance = {
    get isSupported() {
      return purify.mode !== "unsupported";
    },
    sanitize(html: string): DocumentFragment {
      if (purify.mode === "throw") throw new Error("sanitizer exploded");
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
      const fragment = doc.createDocumentFragment();
      while (doc.body.firstChild !== null) fragment.appendChild(doc.body.firstChild);
      Object.defineProperty(fragment, "ownerDocument", { value: doc });
      return fragment;
    },
  };
  return { default: () => instance };
});

const COMMIT = "c".repeat(40);
const SOURCE = "# Hello\n\n[next](../other/next.md) [site](https://example.com/)\n";

function mountFrame(props: Partial<{ source: string; commit: string; filePath: string }> = {}) {
  return mount(MarkdownFrame, {
    props: { source: SOURCE, repoId: 5, commit: COMMIT, filePath: "docs/README.md", ...props },
    global: mountGlobals(),
    attachTo: document.body,
  });
}

async function waitForFrame(wrapper: ReturnType<typeof mountFrame>): Promise<HTMLIFrameElement> {
  for (let i = 0; i < 20; i += 1) {
    const frame = wrapper.element.querySelector("iframe");
    if (frame?.contentDocument?.querySelector("a") != null) {
      // Let the frame's load event attach the parent's listeners.
      await flush(3);
      return frame;
    }
    await flush(1);
  }
  throw new Error("frame never loaded");
}

afterEach(() => {
  purify.mode = "pass";
  document.body.innerHTML = "";
});

describe("MarkdownFrame", () => {
  it("renders into a frame sandboxed with exactly allow-same-origin", async () => {
    const wrapper = mountFrame();
    const frame = await waitForFrame(wrapper);
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Rendered docs/README.md");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toMatch(
      /^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"/,
    );
    expect(srcdoc).toContain("img-src http://localhost:3000/api/repos/5/browse/raw;");
    // Nothing from the document is rendered into the app's own DOM.
    expect(wrapper.element.querySelector(".markdown-frame-host h1")).toBeNull();
    wrapper.unmount();
  });

  it("emits navigate for a tree link and opens external links through window.open", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const wrapper = mountFrame();
    const frame = await waitForFrame(wrapper);
    const doc = frame.contentDocument as Document;
    const [tree, external] = Array.from(doc.querySelectorAll("a"));
    tree?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    external?.dispatchEvent(click);
    expect(wrapper.emitted("navigate")).toEqual([["other/next.md"]]);
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
    expect(click.defaultPrevented).toBe(true);
    open.mockRestore();
    wrapper.unmount();
  });

  it("shows the source as plain text when the sanitizer is not supported", async () => {
    purify.mode = "unsupported";
    const wrapper = mountFrame({ source: "<img src=x onerror=alert(1)>" });
    await flush();
    expect(wrapper.element.querySelector("iframe")).toBeNull();
    expect(wrapper.find("pre").text()).toBe("<img src=x onerror=alert(1)>");
    expect(wrapper.element.querySelector("img")).toBeNull();
    expect(wrapper.text()).toContain("could not be rendered safely");
  });

  it("shows the source as plain text when the sanitizer throws", async () => {
    purify.mode = "throw";
    const wrapper = mountFrame();
    await flush();
    expect(wrapper.element.querySelector("iframe")).toBeNull();
    expect(wrapper.find("pre").text()).toBe(SOURCE.trimEnd());
  });

  it("shows the too-large note for a file over the work budget", async () => {
    const wrapper = mountFrame({ source: "x".repeat(256 * 1024 + 1) });
    await flush();
    expect(wrapper.element.querySelector("iframe")).toBeNull();
    expect(wrapper.text()).toContain("too large or too complex to render here");
    expect(wrapper.text()).not.toContain("could not be rendered safely");
    // The plain-text view does not wrap (see the component's stylesheet).
    expect(markdownFrameSource).toMatch(/\.markdown-frame-source \{[^}]*white-space: pre;/);
  });

  it("fails closed on a commit that is not a full object id", async () => {
    const wrapper = mountFrame({ commit: "main" });
    await flush();
    expect(wrapper.element.querySelector("iframe")).toBeNull();
    expect(wrapper.find("pre").exists()).toBe(true);
  });

  it("recovers when the props change to something renderable", async () => {
    const wrapper = mountFrame({ commit: "main" });
    await flush();
    expect(wrapper.find("pre").exists()).toBe(true);
    await wrapper.setProps({ commit: COMMIT });
    await waitForFrame(wrapper);
    expect(wrapper.find("pre").exists()).toBe(false);
    wrapper.unmount();
  });

  it("has no v-html anywhere", () => {
    expect(markdownFrameSource).not.toMatch(/v-html|innerHTML/);
  });
});

describe("handleFrameClick", () => {
  function clickOn(element: Element, button = 0): MouseEvent {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button });
    Object.defineProperty(event, "target", { value: element });
    return event;
  }

  function anchor(attrs: Record<string, string>): HTMLAnchorElement {
    const a = document.createElement("a");
    for (const [name, value] of Object.entries(attrs)) a.setAttribute(name, value);
    a.append(document.createElement("span"));
    return a;
  }

  it("re-checks the tree path before emitting it", () => {
    const navigate = vi.fn();
    const open = vi.fn();
    handleFrameClick(clickOn(anchor({ href: "#", "data-amber-path": "a/b.md" })), navigate, open);
    handleFrameClick(clickOn(anchor({ href: "#", "data-amber-path": "../x" })), navigate, open);
    expect(navigate.mock.calls).toEqual([["a/b.md"]]);
    expect(open).not.toHaveBeenCalled();
  });

  it("finds the link from a nested element and refuses unsafe hrefs", () => {
    const navigate = vi.fn();
    const open = vi.fn();
    const inner = anchor({ href: "https://example.com/x" }).firstElementChild as Element;
    const event = clickOn(inner);
    handleFrameClick(event, navigate, open);
    handleFrameClick(clickOn(anchor({ href: "javascript:alert(1)" })), navigate, open);
    handleFrameClick(clickOn(anchor({ href: "/api/repos/1" })), navigate, open);
    expect(event.defaultPrevented).toBe(true);
    expect(open.mock.calls).toEqual([["https://example.com/x"]]);
  });

  it("ignores a right click on a link but still cancels it", () => {
    const open = vi.fn();
    const event = clickOn(anchor({ href: "https://example.com/" }), 2);
    handleFrameClick(event, vi.fn(), open);
    expect(open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets a summary toggle and cancels other clicks", () => {
    const summary = document.createElement("summary");
    const summaryClick = clickOn(summary);
    handleFrameClick(summaryClick, vi.fn(), vi.fn());
    expect(summaryClick.defaultPrevented).toBe(false);
    const paragraph = clickOn(document.createElement("p"));
    handleFrameClick(paragraph, vi.fn(), vi.fn());
    expect(paragraph.defaultPrevented).toBe(true);
  });
});

describe("mountMarkdownFrame", () => {
  it("sets the sandbox before the content and removes the frame on dispose", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const handled = vi.fn();
    const mounted = mountMarkdownFrame(
      container,
      "<!DOCTYPE html><html><body><p>x</p></body></html>",
      {
        title: "t",
        onNavigate: vi.fn(),
        onClickHandling: handled,
      },
    );
    expect(mounted.iframe.getAttribute("sandbox")).toBe("allow-same-origin");
    for (let i = 0; i < 20 && handled.mock.calls.length === 0; i += 1) await flush(1);
    expect(handled).toHaveBeenCalledWith(true);
    mounted.dispose();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
