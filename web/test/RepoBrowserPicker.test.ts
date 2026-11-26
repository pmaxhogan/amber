import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import RefPicker from "../src/components/browse/RefPicker.vue";
import RevJump from "../src/components/browse/RevJump.vue";
import { ApiClientError } from "../src/api/client.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, flush } from "./helpers/dom.ts";
import { HEAD_OID, makeBrowseApi, makeRefs, oid } from "./helpers/browseStubs.ts";

const MAIN = { oid: HEAD_OID, kind: "branch" as const, name: "main" };

function mountPicker(
  api = makeBrowseApi(),
  props: Partial<{ branchCount: number; tagCount: number; current: typeof MAIN }> = {},
) {
  const wrapper = mount(RefPicker, {
    props: { repoId: 7, current: MAIN, branchCount: 3, tagCount: 2, debounceMs: 0, ...props },
    global: mountGlobals({ api }),
    attachTo: document.body,
  });
  return { wrapper, api };
}

async function openPicker(wrapper: ReturnType<typeof mountPicker>["wrapper"]) {
  await wrapper.find("button.ref-picker__button").trigger("click");
  await flush();
}

describe("ref picker", () => {
  it("shows the current branch and lists branches when opened", async () => {
    const { wrapper, api } = mountPicker();
    expect(wrapper.find("button.ref-picker__button").text()).toBe("main");

    await openPicker(wrapper);

    expect(api.browseRefs).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.browseRefs).mock.calls[0]?.[0]).toBe(7);
    expect(vi.mocked(api.browseRefs).mock.calls[0]?.[1]).toEqual({ kind: "branch" });
    const options = wrapper.findAll("[role=option]");
    expect(options.map((option) => option.find(".ref-picker__name").text())).toEqual([
      "main",
      "dev",
      "release/1.x",
    ]);
    expect(wrapper.text()).toContain("Branches (3)");
    expect(wrapper.text()).toContain("Tags (2)");
    wrapper.unmount();
  });

  it("shows the short sha when the browser is on a bare commit", () => {
    const { wrapper } = mountPicker(makeBrowseApi(), {
      current: { oid: "0123456789".repeat(4), kind: "commit", name: null } as never,
    });
    expect(wrapper.find("button.ref-picker__button").text()).toBe("0123456");
    wrapper.unmount();
  });

  it("tells a branch, a tag and a commit apart on the button, even when the name looks like a sha", async () => {
    const kindOf = (props: { kind: "branch" | "tag" | "commit"; name: string | null }) => {
      const { wrapper } = mountPicker(makeBrowseApi(), {
        current: { oid: HEAD_OID, ...props } as never,
      });
      const kind = wrapper.find("button.ref-picker__button .ref-picker__kind");
      const result = {
        label: kind.attributes("aria-label"),
        title: kind.attributes("title"),
        icon: kind.find("svg path").attributes("d"),
        text: wrapper.find("button.ref-picker__button").text(),
      };
      wrapper.unmount();
      return result;
    };

    const branch = kindOf({ kind: "branch", name: "abc1234" });
    const tag = kindOf({ kind: "tag", name: "v1" });
    const commit = kindOf({ kind: "commit", name: null });

    expect([branch.label, tag.label, commit.label]).toEqual(["Branch", "Tag", "Commit"]);
    expect([branch.title, tag.title, commit.title]).toEqual(["Branch", "Tag", "Commit"]);
    expect(new Set([branch.icon, tag.icon, commit.icon]).size).toBe(3);
    // The visible text is the name; the kind is never folded into it.
    expect(branch.text).toBe("abc1234");
  });

  it("marks each row of the list with its own kind", async () => {
    const mixed = makeRefs({
      rows: [
        { kind: "branch", name: "main", oid: HEAD_OID },
        { kind: "tag", name: "v1.0.0", oid: oid("f") },
      ],
    });
    const api = makeBrowseApi({}, { browseRefs: vi.fn().mockResolvedValue(mixed) });
    const { wrapper } = mountPicker(api);
    await openPicker(wrapper);

    const labels = wrapper
      .findAll("[role=option] .ref-picker__kind")
      .map((icon) => icon.attributes("aria-label"));
    expect(labels).toEqual(["Branch", "Tag"]);
    expect(wrapper.findAll("[role=option]").map((o) => o.find(".ref-picker__name").text())).toEqual(
      ["main", "v1.0.0"],
    );
    wrapper.unmount();
  });

  it("queries tags when the Tags tab is chosen", async () => {
    const tags = makeRefs({
      rows: [{ kind: "tag", name: "v1.0.0", oid: oid("f") }],
    });
    const api = makeBrowseApi({}, { browseRefs: vi.fn().mockResolvedValue(tags) });
    const { wrapper } = mountPicker(api);
    await openPicker(wrapper);

    await clickButton(wrapper, "Tags (2)");
    await flush();

    expect(vi.mocked(api.browseRefs).mock.calls.at(-1)?.[1]).toEqual({ kind: "tag" });
    expect(wrapper.findAll("[role=option]").map((o) => o.text())).toEqual([
      expect.stringContaining("v1.0.0"),
    ]);
    wrapper.unmount();
  });

  it("opens on tags when the backup has no branches", async () => {
    const { wrapper, api } = mountPicker(makeBrowseApi(), { branchCount: 0, tagCount: 2 });
    await openPicker(wrapper);
    expect(vi.mocked(api.browseRefs).mock.calls[0]?.[1]).toEqual({ kind: "tag" });
    wrapper.unmount();
  });

  it("filters on the server as the user types", async () => {
    const { wrapper, api } = mountPicker();
    await openPicker(wrapper);

    await wrapper.find("input[type=search]").setValue("rel");
    await flush();

    expect(vi.mocked(api.browseRefs).mock.calls.at(-1)?.[1]).toEqual({ kind: "branch", q: "rel" });
    wrapper.unmount();
  });

  it("says when more refs match than are listed", async () => {
    const api = makeBrowseApi(
      {},
      { browseRefs: vi.fn().mockResolvedValue(makeRefs({ truncated: true })) },
    );
    const { wrapper } = mountPicker(api);
    await openPicker(wrapper);
    expect(wrapper.text()).toContain("More refs match than are listed");
    wrapper.unmount();
  });

  it("says nothing matched", async () => {
    const api = makeBrowseApi(
      {},
      { browseRefs: vi.fn().mockResolvedValue(makeRefs({ rows: [] })) },
    );
    const { wrapper } = mountPicker(api);
    await openPicker(wrapper);
    await wrapper.find("input[type=search]").setValue("zzz");
    await flush();
    expect(wrapper.text()).toContain("No refs match.");
    wrapper.unmount();
  });

  it("selects by the row's commit id, not by re-resolving its name", async () => {
    const { wrapper, api } = mountPicker();
    await openPicker(wrapper);

    await wrapper.findAll("[role=option]")[1]?.trigger("click");

    expect(wrapper.emitted("select")).toEqual([[{ oid: oid("b"), kind: "branch", name: "dev" }]]);
    expect(api.browseResolve).not.toHaveBeenCalled();
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
    wrapper.unmount();
  });

  describe("Enter in the search box", () => {
    async function typeAndEnter(wrapper: ReturnType<typeof mountPicker>["wrapper"], text: string) {
      const input = wrapper.find("input[type=search]");
      await input.setValue(text);
      await flush();
      await input.trigger("keydown", { key: "Enter" });
      await flush();
    }

    it("jumps to a branch that is not among the visible rows", async () => {
      const api = makeBrowseApi();
      vi.mocked(api.browseResolve).mockResolvedValue({
        oid: oid("9"),
        kind: "branch",
        name: "hidden/branch",
      });
      const { wrapper } = mountPicker(api);
      await openPicker(wrapper);

      await typeAndEnter(wrapper, "hidden/branch");

      expect(vi.mocked(api.browseResolve).mock.calls[0]?.slice(0, 2)).toEqual([7, "hidden/branch"]);
      expect(wrapper.emitted("select")).toEqual([
        [{ oid: oid("9"), kind: "branch", name: "hidden/branch" }],
      ]);
      expect(wrapper.find("[role=listbox]").exists()).toBe(false);
      expect(wrapper.find("input[type=search]").exists()).toBe(false);
      wrapper.unmount();
    });

    it("jumps to a sha from the Tags tab", async () => {
      const api = makeBrowseApi();
      vi.mocked(api.browseResolve).mockResolvedValue({
        oid: oid("7"),
        kind: "commit",
        name: null,
      });
      const { wrapper } = mountPicker(api);
      await openPicker(wrapper);
      await clickButton(wrapper, "Tags (2)");
      await flush();

      await typeAndEnter(wrapper, "7777777");

      expect(vi.mocked(api.browseResolve).mock.calls[0]?.slice(0, 2)).toEqual([7, "7777777"]);
      expect(wrapper.emitted("select")).toEqual([[{ oid: oid("7"), kind: "commit", name: null }]]);
      wrapper.unmount();
    });

    it("does nothing for empty text", async () => {
      const { wrapper, api } = mountPicker();
      await openPicker(wrapper);
      await wrapper.find("input[type=search]").trigger("keydown", { key: "Enter" });
      await flush();
      expect(api.browseResolve).not.toHaveBeenCalled();
      expect(wrapper.emitted("select")).toBeUndefined();
      expect(wrapper.find("[role=listbox]").exists()).toBe(true);
      wrapper.unmount();
    });

    it("says it is not in this backup, keeps the picker open, and clears when typing", async () => {
      const { wrapper } = mountPicker();
      await openPicker(wrapper);

      await typeAndEnter(wrapper, "nonsense");

      expect(wrapper.emitted("select")).toBeUndefined();
      expect(wrapper.find("input[type=search]").exists()).toBe(true);
      expect(wrapper.find("[role=alert]").text()).toBe('"nonsense" is not in this backup.');

      await wrapper.find("input[type=search]").setValue("nonsens");
      expect(wrapper.find("[role=alert]").exists()).toBe(false);
      wrapper.unmount();
    });

    it("shows other failures as they are", async () => {
      const api = makeBrowseApi(
        {},
        {
          browseResolve: vi
            .fn()
            .mockRejectedValue(new ApiClientError("boom", "Server fell over", 500)),
        },
      );
      const { wrapper } = mountPicker(api);
      await openPicker(wrapper);
      await typeAndEnter(wrapper, "main");
      expect(wrapper.find("[role=alert]").text()).toBe("Server fell over");
      wrapper.unmount();
    });
  });

  it("closes on Escape", async () => {
    const { wrapper } = mountPicker();
    await openPicker(wrapper);
    await wrapper.find("input[type=search]").trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("reports a failed lookup in the panel", async () => {
    const api = makeBrowseApi(
      {},
      { browseRefs: vi.fn().mockRejectedValue(new ApiClientError("boom", "It broke", 500)) },
    );
    const { wrapper } = mountPicker(api);
    await openPicker(wrapper);
    expect(wrapper.find("[role=alert]").text()).toBe("It broke");
    wrapper.unmount();
  });

  it("is disabled, with an explanation, when the backup holds a single ref", async () => {
    const { wrapper } = mountPicker(makeBrowseApi(), { branchCount: 1, tagCount: 0 });
    const button = wrapper.find("button.ref-picker__button");

    expect(button.attributes("disabled")).toBeDefined();
    expect(button.text()).toBe("main");
    const tip = wrapper.find(".ref-picker__anchor").attributes("title");
    expect(tip).toContain("only holds one ref (main)");
    expect(tip).toContain("shallow");
    expect(wrapper.find(".sr-only").text()).toBe(tip);
    expect(button.attributes("aria-describedby")).toBe(wrapper.find(".sr-only").attributes("id"));

    await button.trigger("click");
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("treats one tag and no branches as a single ref too", () => {
    const { wrapper } = mountPicker(makeBrowseApi(), { branchCount: 0, tagCount: 1 });
    expect(wrapper.find("button.ref-picker__button").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("stays enabled and tooltip-free when there is a choice", () => {
    const { wrapper } = mountPicker();
    expect(wrapper.find("button.ref-picker__button").attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".ref-picker__anchor").attributes("title")).toBeUndefined();
    wrapper.unmount();
  });
});

describe("rev jump", () => {
  function mountJump(api = makeBrowseApi()) {
    const wrapper = mount(RevJump, { props: { repoId: 7 }, global: mountGlobals({ api }) });
    return { wrapper, api };
  }

  it("resolves what was typed on Enter and emits the result", async () => {
    const { wrapper, api } = mountJump();
    const input = wrapper.find("input");
    await input.setValue("  dev ");
    await input.trigger("keydown", { key: "Enter" });
    await flush();

    expect(vi.mocked(api.browseResolve).mock.calls[0]?.slice(0, 2)).toEqual([7, "dev"]);
    expect(wrapper.emitted("jump")).toEqual([[{ oid: oid("b"), kind: "branch", name: "dev" }]]);
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  it("does nothing for blank input", async () => {
    const { wrapper, api } = mountJump();
    await wrapper.find("input").trigger("keydown", { key: "Enter" });
    expect(api.browseResolve).not.toHaveBeenCalled();
  });

  it("says the revision is not in this backup on a 404", async () => {
    const { wrapper } = mountJump();
    const input = wrapper.find("input");
    await input.setValue("nope");
    await input.trigger("keydown", { key: "Enter" });
    await flush();

    expect(wrapper.emitted("jump")).toBeUndefined();
    expect(wrapper.find("[role=alert]").text()).toBe('"nope" is not in this backup.');
    expect((input.element as HTMLInputElement).value).toBe("nope");

    await input.setValue("nop");
    expect(wrapper.find("[role=alert]").exists()).toBe(false);
  });

  it("shows other failures as they are", async () => {
    const api = makeBrowseApi(
      {},
      {
        browseResolve: vi
          .fn()
          .mockRejectedValue(new ApiClientError("boom", "Server fell over", 500)),
      },
    );
    const { wrapper } = mountJump(api);
    const input = wrapper.find("input");
    await input.setValue("main");
    await input.trigger("keydown", { key: "Enter" });
    await flush();
    expect(wrapper.find("[role=alert]").text()).toBe("Server fell over");
  });
});
