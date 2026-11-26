import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ForkParentLink from "../src/components/ForkParentLink.vue";
import { mountGlobals } from "./helpers/mount.ts";
import { flush } from "./helpers/dom.ts";
import { makeForge, makeRepo, stubApi } from "./helpers/stubApi.ts";

const FORGE = makeForge({ port: 8443, host: "git.example.com" });

function mountLink(
  repoExtra: Record<string, unknown>,
  opts: { forge?: unknown; api?: ReturnType<typeof stubApi>; attachTo?: HTMLElement } = {},
) {
  const api = opts.api ?? stubApi();
  const wrapper = mount(ForkParentLink, {
    props: { repo: makeRepo(repoExtra), forge: ("forge" in opts ? opts.forge : FORGE) as never },
    global: mountGlobals({ api }),
    ...(opts.attachTo === undefined ? {} : { attachTo: opts.attachTo }),
  });
  return { wrapper, api };
}

const click = (el: Element, init: MouseEventInit = {}): MouseEvent => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
};

describe("ForkParentLink", () => {
  it("renders nothing for a repo that is not a fork", () => {
    const { wrapper } = mountLink({ forkParent: null });
    expect(wrapper.find("a, span").exists()).toBe(false);
  });

  it("links to the upstream on the repo's own forge origin", () => {
    const { wrapper } = mountLink({ forkParent: "grp/a b" });
    expect(wrapper.find("a").attributes("href")).toBe("https://git.example.com:8443/grp/a%20b");
  });

  it("shows plain text, not a dead link, while the forge is unknown", () => {
    const { wrapper } = mountLink({ forkParent: "up/x" }, { forge: undefined });
    expect(wrapper.find("a").exists()).toBe(false);
    expect(wrapper.find("span.fork-link").text()).toBe("up/x");
  });

  it("emits the fetched upstream on a plain click of a tracked one", async () => {
    const upstream = makeRepo({ id: 9, path: "up/x" });
    const api = stubApi({ getRepo: vi.fn().mockResolvedValue(upstream) } as never);
    const { wrapper } = mountLink({ forkParent: "up/x", forkParentRepoId: 9 }, { api });

    const event = click(wrapper.find("a").element);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.emitted("open")).toEqual([[upstream]]);
  });

  it("does not hijack a middle click or a modified click, but never lets either reach the row", async () => {
    const getRepo = vi.fn();
    const row = document.createElement("tr");
    document.body.appendChild(row);
    const reached = vi.fn();
    row.addEventListener("click", reached);
    const { wrapper } = mountLink(
      { forkParent: "up/x", forkParentRepoId: 9 },
      { api: stubApi({ getRepo } as never), attachTo: row },
    );

    const middle = click(wrapper.find("a").element, { button: 1 });
    const meta = click(wrapper.find("a").element, { metaKey: true });
    await flush();

    expect(middle.defaultPrevented).toBe(false);
    expect(meta.defaultPrevented).toBe(false);
    expect(getRepo).not.toHaveBeenCalled();
    expect(wrapper.emitted("open")).toBeUndefined();
    expect(reached).not.toHaveBeenCalled();
    wrapper.unmount();
    row.remove();
  });

  it("falls back to the forge page when the upstream cannot be read", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const api = stubApi({ getRepo: vi.fn().mockRejectedValue(new Error("boom")) } as never);
    const { wrapper } = mountLink({ forkParent: "up/x", forkParentRepoId: 9 }, { api });

    click(wrapper.find("a").element);
    await flush();

    expect(open).toHaveBeenCalledWith(
      "https://git.example.com:8443/up/x",
      "_blank",
      "noopener,noreferrer",
    );
    expect(wrapper.emitted("open")).toBeUndefined();
    open.mockRestore();
  });
});
