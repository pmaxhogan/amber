import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { RouterView } from "vue-router";
import GitRemotePage from "../src/pages/GitRemotePage.vue";
import ConfirmDialog from "../src/components/ConfirmDialog.vue";
import { routes } from "../src/router/index.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import { makeGitRemote, stubApi } from "./helpers/stubApi.ts";

const SECRET = "3Kq9vHt2XbLmNpQrSuVwXyZa1B4c6D8e";

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: false })),
    enableGitRemote: vi
      .fn()
      .mockResolvedValue({ ...makeGitRemote({ enabled: true }), password: SECRET }),
    rotateGitRemote: vi
      .fn()
      .mockResolvedValue({ ...makeGitRemote({ enabled: true }), password: "rotated-secret-value" }),
    disableGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: false })),
    ...overrides,
  } as never);
}

async function mountPage(api = buildApi()) {
  const wrapper = mount(GitRemotePage, { global: mountGlobals({ api }) });
  await flush();
  return { wrapper, api };
}

interface DialogSearchable {
  findAllComponents: (component: typeof ConfirmDialog) => {
    props: (name: string) => unknown;
    vm: { $emit: (event: string) => void };
  }[];
}

async function confirmVisible(wrapper: DialogSearchable): Promise<void> {
  const dialog = wrapper
    .findAllComponents(ConfirmDialog)
    .find((entry) => entry.props("visible") === true);
  dialog?.vm.$emit("confirm");
  await flush();
}

describe("Git remote status", () => {
  it("shows the disabled state and only the enable action", async () => {
    const { wrapper } = await mountPage();

    expect(wrapper.find(".p-tag").text()).toBe("disabled");
    expect(findButton(wrapper, "Enable read-only remote")).toBeDefined();
    expect(findButton(wrapper, "Rotate password")).toBeUndefined();
  });

  it("shows rotate and disable once enabled", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
    });
    const { wrapper } = await mountPage(api);

    expect(findButton(wrapper, "Rotate password")).toBeDefined();
    expect(findButton(wrapper, "Disable")).toBeDefined();
  });

  it("explains the Access bypass plus basic auth model in plain words", async () => {
    const { wrapper } = await mountPage();
    const text = wrapper.text();

    expect(text).toContain("Bypass policy");
    expect(text).toContain("basic auth");
    expect(text).toContain("receive-pack");
  });

  it("confirms before enabling rather than generating a password on a stray click", async () => {
    const { wrapper, api } = await mountPage();

    await clickButton(wrapper, "Enable read-only remote");
    await flush();

    expect(api.enableGitRemote).not.toHaveBeenCalled();
    const dialog = wrapper
      .findAllComponents(ConfirmDialog)
      .find((entry) => entry.props("visible") === true);
    expect(dialog?.props("title")).toBe("Enable the read-only git remote?");
  });
});

describe("one-time password reveal", () => {
  it("shows the generated password exactly once, with the warning", async () => {
    const { wrapper } = await mountPage();

    await clickButton(wrapper, "Enable read-only remote");
    await flush();
    await confirmVisible(wrapper);

    const reveal = wrapper.find('[data-testid="password-reveal"]');
    expect(reveal.exists()).toBe(true);
    expect(reveal.text()).toContain("This password will never be shown again.");
    expect(reveal.find("input").element.value).toBe(SECRET);
  });

  it("announces the reveal assertively, since it cannot be recovered", async () => {
    const { wrapper } = await mountPage();
    await clickButton(wrapper, "Enable read-only remote");
    await flush();
    await confirmVisible(wrapper);

    const reveal = wrapper.find('[data-testid="password-reveal"]');
    expect(reveal.attributes("role")).toBe("alert");
    expect(reveal.attributes("aria-live")).toBe("assertive");
  });

  it("does not show the password before enabling", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(false);
  });

  it("drops the password when the user acknowledges it", async () => {
    const { wrapper } = await mountPage();
    await clickButton(wrapper, "Enable read-only remote");
    await flush();
    await confirmVisible(wrapper);

    await clickButton(wrapper, "I have saved it");
    await flush();

    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(SECRET);
  });

  it("is gone after navigating away and back", async () => {
    // The reveal lives in component-local state and nowhere else, so leaving
    // the route destroys it. If it ever moved into a store or storage this
    // test is what catches it.
    const api = buildApi();
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/git-remote");
    await router.isReady();
    const wrapper = mount(RouterView, { global: mountGlobals({ api, router }) });
    await flush();

    await clickButton(wrapper, "Enable read-only remote");
    await flush();
    await confirmVisible(wrapper);
    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(true);

    await router.push("/about");
    await flush();
    await router.push("/git-remote");
    await flush();

    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(SECRET);
  });

  it("reveals a fresh password on rotate", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
    });
    const { wrapper } = await mountPage(api);

    await clickButton(wrapper, "Rotate password");
    await flush();
    await confirmVisible(wrapper);

    expect(wrapper.find('[data-testid="password-reveal"] input').element).toHaveProperty(
      "value",
      "rotated-secret-value",
    );
  });

  it("clears any revealed password when the remote is disabled", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
    });
    const { wrapper } = await mountPage(api);
    await clickButton(wrapper, "Rotate password");
    await flush();
    await confirmVisible(wrapper);

    await clickButton(wrapper, "Disable");
    await flush();
    await confirmVisible(wrapper);

    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(false);
  });
});

describe("username edit", () => {
  it("keeps the save button inert until the username actually changes", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
    });
    const { wrapper } = await mountPage(api);

    expect(findButton(wrapper, "Save username")?.attributes().disabled).toBeDefined();

    await wrapper.find('input[aria-label="Git remote username"]').setValue("mirror-bot");
    await flush();

    expect(findButton(wrapper, "Save username")?.attributes().disabled).toBeUndefined();
  });

  it("sends the trimmed username", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
      setGitRemoteUsername: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
    });
    const { wrapper } = await mountPage(api);

    await wrapper.find('input[aria-label="Git remote username"]').setValue("  mirror-bot  ");
    await flush();
    await clickButton(wrapper, "Save username");
    await flush();

    expect(api.setGitRemoteUsername).toHaveBeenCalledWith("mirror-bot");
  });
});
