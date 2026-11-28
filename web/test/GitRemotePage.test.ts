import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import GitRemotePage from "../src/pages/GitRemotePage.vue";
import ConfirmDialog from "../src/components/ConfirmDialog.vue";
import { routes } from "../src/router/index.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import { makeGitRemote, makeUser, stubApi } from "./helpers/stubApi.ts";
import type { Me } from "@amber/shared";

const SECRET = "3Kq9vHt2XbLmNpQrSuVwXyZa1B4c6D8e";

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
    rotateGitRemote: vi.fn().mockResolvedValue({
      ...makeGitRemote({ enabled: true, hasPassword: true, rotatedAt: 1_700_000_000_000 }),
      password: SECRET,
    }),
    revokeGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
    enableGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })),
    disableGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: false })),
    ...overrides,
  } as never);
}

async function mountPage(api = buildApi(), me?: Me) {
  const wrapper = mount(GitRemotePage, { global: mountGlobals({ api, me }) });
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

describe("per-user credential", () => {
  it("offers to create a password and shows no username before one exists", async () => {
    const { wrapper } = await mountPage(
      buildApi({
        getGitRemote: vi
          .fn()
          .mockResolvedValue(
            makeGitRemote({ enabled: true, username: null, cloneUrlTemplate: null }),
          ),
      }),
    );

    expect(findButton(wrapper, "Create password")).toBeDefined();
    expect(findButton(wrapper, "Rotate password")).toBeUndefined();
    expect(findButton(wrapper, "Revoke")).toBeUndefined();
    expect(wrapper.find('[data-testid="git-username"]').text()).toBe("-");
  });

  it("shows my username and the clone template once minted, with rotate and revoke", async () => {
    const api = buildApi({
      getGitRemote: vi
        .fn()
        .mockResolvedValue(
          makeGitRemote({ enabled: true, hasPassword: true, rotatedAt: 1_700_000_000_000 }),
        ),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.find('[data-testid="git-username"]').text()).toBe("k3j9x0abcd");
    expect(wrapper.find('[data-testid="clone-template"]').text()).toContain("{password}");
    expect(findButton(wrapper, "Rotate password")).toBeDefined();
    expect(findButton(wrapper, "Revoke")).toBeDefined();
    expect(findButton(wrapper, "Create password")).toBeUndefined();
  });

  it("says the credential stops working when access is removed", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.text()).toContain("stops working as soon as your access to Amber is removed");
  });

  it("says plainly when the remote is switched off, and still manages the password", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: false })),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.find('[data-testid="remote-off"]').exists()).toBe(true);
    expect(findButton(wrapper, "Create password")).toBeDefined();
  });

  it("explains the Access bypass plus basic auth model in plain words", async () => {
    const { wrapper } = await mountPage();
    const text = wrapper.text();

    expect(text).toContain("Bypass policy");
    expect(text).toContain("basic auth");
    expect(text).toContain("receive-pack");
  });
});

describe("one-time password reveal", () => {
  it("creates the first password without a confirm and shows it once, with the warning", async () => {
    const { wrapper, api } = await mountPage(
      buildApi({ getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true })) }),
    );

    await clickButton(wrapper, "Create password");
    await flush();

    expect(api.rotateGitRemote).toHaveBeenCalledTimes(1);
    const reveal = wrapper.find('[data-testid="password-reveal"]');
    expect(reveal.exists()).toBe(true);
    expect(reveal.text()).toContain("You will not see this password again.");
    expect((reveal.find("input").element as HTMLInputElement).value).toBe(SECRET);
    // The copy button is there.
    expect(reveal.find('button[aria-label="Copy Git password"]').exists()).toBe(true);
  });

  it("announces the reveal assertively, since it cannot be recovered", async () => {
    const { wrapper } = await mountPage();
    await clickButton(wrapper, "Create password");
    await flush();

    const reveal = wrapper.find('[data-testid="password-reveal"]');
    expect(reveal.attributes("role")).toBe("alert");
    expect(reveal.attributes("aria-live")).toBe("assertive");
  });

  it("does not show a password before one is created", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(false);
  });

  it("drops the password when the user acknowledges it", async () => {
    const { wrapper } = await mountPage();
    await clickButton(wrapper, "Create password");
    await flush();

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

    await clickButton(wrapper, "Create password");
    await flush();
    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(true);

    await router.push("/about");
    await flush();
    await router.push("/git-remote");
    await flush();

    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(SECRET);
  });

  it("asks before rotating an existing password, then reveals the new one", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true, hasPassword: true })),
    });
    const { wrapper } = await mountPage(api);

    await clickButton(wrapper, "Rotate password");
    await flush();
    expect(api.rotateGitRemote).not.toHaveBeenCalled();
    await confirmVisible(wrapper);

    expect(api.rotateGitRemote).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="password-reveal"] input').element).toHaveProperty(
      "value",
      SECRET,
    );
  });

  it("clears a revealed password when it is revoked", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: true, hasPassword: true })),
    });
    const { wrapper } = await mountPage(api);
    await clickButton(wrapper, "Rotate password");
    await flush();
    await confirmVisible(wrapper);
    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(true);

    await clickButton(wrapper, "Revoke");
    await flush();
    await confirmVisible(wrapper);

    expect(api.revokeGitRemote).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="password-reveal"]').exists()).toBe(false);
  });
});

describe("the global switch", () => {
  it("is hidden from a user without manage_settings", async () => {
    const { wrapper } = await mountPage(buildApi(), makeUser());
    expect(findButton(wrapper, "Turn the git remote off")).toBeUndefined();
    expect(findButton(wrapper, "Turn the git remote on")).toBeUndefined();
  });

  it("is shown to a user with manage_settings and turns the remote off after a confirm", async () => {
    const { wrapper, api } = await mountPage(buildApi(), makeUser({ manage_settings: true }));

    await clickButton(wrapper, "Turn the git remote off");
    await flush();
    expect(api.disableGitRemote).not.toHaveBeenCalled();
    await confirmVisible(wrapper);

    expect(api.disableGitRemote).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="remote-state"]').text()).toBe("remote off");
  });

  it("turns the remote back on", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: false })),
    });
    const { wrapper } = await mountPage(api);

    await clickButton(wrapper, "Turn the git remote on");
    await flush();

    expect(api.enableGitRemote).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="remote-state"]').text()).toBe("remote on");
  });
});
