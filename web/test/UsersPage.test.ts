import { describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import InputNumber from "primevue/inputnumber";
import { PERMISSIONS } from "@amber/shared";
import UsersPage from "../src/pages/UsersPage.vue";
import ConfirmDialog from "../src/components/ConfirmDialog.vue";
import { ApiClientError } from "../src/api/client.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import { makeMe, makeUserRow, stubApi } from "./helpers/stubApi.ts";

const GB = 1024 ** 3;

const ADMIN_ROW = makeUserRow({
  id: 1,
  email: "admin@example.com",
  isAdmin: true,
  permissions: Object.fromEntries(PERMISSIONS.map((p) => [p.key, true])) as never,
  capBytes: null,
  repoCount: 4,
});
const FRIEND = makeUserRow({ id: 2, email: "friend@example.com", repoCount: 3 });
const GONE = makeUserRow({
  id: 3,
  email: "gone@example.com",
  removedAt: 1_700_000_100_000,
  repoCount: 2,
  hasGitPassword: false,
});

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    listUsers: vi.fn().mockResolvedValue([ADMIN_ROW, FRIEND, GONE]),
    updateUser: vi.fn(async (id: number, input: Record<string, unknown>) => ({
      ...FRIEND,
      id,
      ...(input.storageCapBytes !== undefined ? { storageCapBytes: input.storageCapBytes } : {}),
      permissions: { ...FRIEND.permissions, ...((input.permissions as object | undefined) ?? {}) },
    })),
    revokeUserGit: vi.fn(async () => ({ ...FRIEND, hasGitPassword: false })),
    adoptUserRepos: vi.fn().mockResolvedValue({ userId: 3, adopted: 2 }),
    refreshUsers: vi.fn().mockResolvedValue({
      ok: true,
      error: null,
      policy: {
        configured: true,
        fetchedAt: 1_700_000_500_000,
        stale: false,
        editUrl: "https://dash.cloudflare.com/a/one/access-controls/policies/p/edit",
      },
      changes: { created: 1, removed: 1, restored: 0 },
    }),
    ...overrides,
  } as never);
}

async function mountPage(api = buildApi(), me = makeMe()) {
  const wrapper = mount(UsersPage, { global: mountGlobals({ api, me }) });
  await flush();
  return { wrapper, api };
}

/** PrimeVue's InputNumber commits on blur, so tests drive its model directly. */
async function setCap(wrapper: VueWrapper, id: number, value: number | null): Promise<void> {
  const field = wrapper
    .findAllComponents(InputNumber)
    .find((entry) => entry.props("inputId") === `cap-${id}`);
  field?.vm.$emit("update:modelValue", value);
  await flush();
}

function userBlock(wrapper: Awaited<ReturnType<typeof mountPage>>["wrapper"], id: number) {
  return wrapper.find(`[data-testid="user-${id}"]`);
}

interface Dialog {
  findAllComponents: (c: typeof ConfirmDialog) => {
    props: (name: string) => unknown;
    vm: { $emit: (event: string) => void };
  }[];
}

async function confirmVisible(wrapper: Dialog): Promise<void> {
  wrapper
    .findAllComponents(ConfirmDialog)
    .find((entry) => entry.props("visible") === true)
    ?.vm.$emit("confirm");
  await flush();
}

describe("users table", () => {
  it("lists every user with email, tags, repos, storage and git password", async () => {
    const { wrapper } = await mountPage();

    const rows = wrapper.findAll('[data-testid="users-table"] tbody');
    expect(rows).toHaveLength(3);
    expect(userBlock(wrapper, 1).text()).toContain("admin");
    expect(userBlock(wrapper, 2).text()).toContain("friend@example.com");
    expect(userBlock(wrapper, 2).text()).toContain("1.00 MB of 5.00 GB");
    expect(userBlock(wrapper, 3).text()).toContain("removed");
    expect(userBlock(wrapper, 2).find('[data-testid="has-git"]').exists()).toBe(false);
  });

  it("marks a user over their cap", async () => {
    const api = buildApi({
      listUsers: vi
        .fn()
        .mockResolvedValue([ADMIN_ROW, { ...FRIEND, overCap: true, usedBytes: 6 * GB }]),
    });
    const { wrapper } = await mountPage(api);
    expect(userBlock(wrapper, 2).find('[data-testid="over-cap"]').exists()).toBe(true);
    expect(userBlock(wrapper, 1).find('[data-testid="over-cap"]').exists()).toBe(false);
  });

  it("renders all 11 permission toggles from the shared list, with its labels", async () => {
    const { wrapper } = await mountPage();
    const block = userBlock(wrapper, 2);

    expect(PERMISSIONS).toHaveLength(11);
    expect(block.findAll(".perm")).toHaveLength(11);
    for (const permission of PERMISSIONS) {
      expect(block.text()).toContain(permission.label);
      expect(block.text()).toContain(permission.description);
    }
  });

  it("shows the admin row with every permission on and read-only", async () => {
    const { wrapper } = await mountPage();
    const block = userBlock(wrapper, 1);

    const inputs = block.findAll(".perm input[type=checkbox]");
    expect(inputs).toHaveLength(11);
    for (const input of inputs) {
      expect((input.element as HTMLInputElement).checked).toBe(true);
      expect(input.attributes("disabled")).toBeDefined();
    }
    expect(block.text()).toContain("cannot be changed");
    // No cap editor and no adopt on the admin row.
    expect(block.find(".cap-edit").exists()).toBe(false);
    expect(findButton(block as never, "Adopt repos")).toBeUndefined();
  });
});

describe("permission toggles", () => {
  it("saves one key with a PATCH and shows the returned row", async () => {
    const { wrapper, api } = await mountPage();
    const input = userBlock(wrapper, 2).find("#perm-2-import_private");
    expect((input.element as HTMLInputElement).checked).toBe(false);

    await input.setValue(true);
    await flush();

    expect(api.updateUser).toHaveBeenCalledWith(2, { permissions: { import_private: true } });
    // The page now shows what the server answered, not an optimistic guess.
    expect(
      (userBlock(wrapper, 2).find("#perm-2-import_private").element as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("does not change the toggle when the save fails", async () => {
    const api = buildApi({
      updateUser: vi.fn().mockRejectedValue(new ApiClientError("forbidden", "no", 403)),
    });
    const { wrapper } = await mountPage(api);

    await userBlock(wrapper, 2).find("#perm-2-import_private").setValue(true);
    await flush();

    expect(
      (userBlock(wrapper, 2).find("#perm-2-import_private").element as HTMLInputElement).checked,
    ).toBe(false);
  });
});

describe("storage cap", () => {
  it("keeps Save cap inert until the value changes, then sends bytes", async () => {
    const { wrapper, api } = await mountPage();
    const block = userBlock(wrapper, 2);
    expect(findButton(block as never, "Save cap")?.attributes().disabled).toBeDefined();

    await setCap(wrapper as never, 2, 10);
    expect(findButton(block as never, "Save cap")?.attributes().disabled).toBeUndefined();

    await clickButton(block as never, "Save cap");
    await flush();

    expect(api.updateUser).toHaveBeenCalledWith(2, { storageCapBytes: 10 * GB });
  });

  it("sends null for a blank cap, meaning the default", async () => {
    const api = buildApi({
      listUsers: vi
        .fn()
        .mockResolvedValue([ADMIN_ROW, { ...FRIEND, storageCapBytes: 2 * GB, capBytes: 2 * GB }]),
    });
    const { wrapper } = await mountPage(api);
    const block = userBlock(wrapper, 2);

    await setCap(wrapper as never, 2, null);
    await clickButton(block as never, "Save cap");
    await flush();

    expect(api.updateUser).toHaveBeenCalledWith(2, { storageCapBytes: null });
  });
});

describe("git password and adoption", () => {
  it("offers Revoke only to users who have a password, and confirms first", async () => {
    const api = buildApi({
      listUsers: vi.fn().mockResolvedValue([ADMIN_ROW, { ...FRIEND, hasGitPassword: true }]),
    });
    const { wrapper } = await mountPage(api);
    expect(findButton(userBlock(wrapper, 2) as never, "Revoke git password")).toBeDefined();

    await clickButton(userBlock(wrapper, 2) as never, "Revoke git password");
    await flush();
    expect(api.revokeUserGit).not.toHaveBeenCalled();
    await confirmVisible(wrapper);

    expect(api.revokeUserGit).toHaveBeenCalledWith(2);
    expect(userBlock(wrapper, 2).find('[data-testid="has-git"]').exists()).toBe(false);
  });

  it("hides Revoke when there is no password", async () => {
    const { wrapper } = await mountPage();
    expect(findButton(userBlock(wrapper, 2) as never, "Revoke git password")).toBeUndefined();
  });

  it("adopts a removed user's repos only after a confirm, and reloads", async () => {
    const { wrapper, api } = await mountPage();

    await clickButton(userBlock(wrapper, 3) as never, "Adopt repos");
    await flush();
    expect(api.adoptUserRepos).not.toHaveBeenCalled();
    await confirmVisible(wrapper);

    expect(api.adoptUserRepos).toHaveBeenCalledWith(3);
    expect(api.listUsers).toHaveBeenCalledTimes(2);
  });

  it("hides Adopt for a user with no repos", async () => {
    const api = buildApi({
      listUsers: vi.fn().mockResolvedValue([ADMIN_ROW, { ...FRIEND, repoCount: 0 }]),
    });
    const { wrapper } = await mountPage(api);
    expect(findButton(userBlock(wrapper, 2) as never, "Adopt repos")).toBeUndefined();
  });
});

describe("access policy", () => {
  it("links to the Cloudflare editor in a new tab without opener", async () => {
    const { wrapper } = await mountPage();
    const link = wrapper.find('a[href^="https://dash.cloudflare.com/"]');
    expect(link.text()).toContain("Edit the Access policy in Cloudflare");
    expect(link.attributes("target")).toBe("_blank");
    expect(link.attributes("rel")).toContain("noopener");
  });

  it("refreshes from Cloudflare and says what changed", async () => {
    const { wrapper, api } = await mountPage();

    await clickButton(wrapper, "Refresh from Cloudflare");
    await flush();

    expect(api.refreshUsers).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="refresh-result"]').text()).toBe(
      "1 user added, 1 user removed",
    );
    expect(api.listUsers).toHaveBeenCalledTimes(2);
  });

  it("says nothing changed when nothing did", async () => {
    const api = buildApi({
      refreshUsers: vi.fn().mockResolvedValue({
        ok: true,
        error: null,
        policy: makeMe().policy,
        changes: { created: 0, removed: 0, restored: 0 },
      }),
    });
    const { wrapper } = await mountPage(api);
    await clickButton(wrapper, "Refresh from Cloudflare");
    await flush();
    expect(wrapper.find('[data-testid="refresh-result"]').text()).toBe("Nothing changed.");
  });

  it("shows a failed refresh as a warning", async () => {
    const api = buildApi({
      refreshUsers: vi.fn().mockResolvedValue({
        ok: false,
        error: "Cloudflare answered 500",
        policy: { ...makeMe().policy, stale: true, lastError: "Cloudflare answered 500" },
        changes: { created: 0, removed: 0, restored: 0 },
      }),
    });
    const { wrapper } = await mountPage(api);
    await clickButton(wrapper, "Refresh from Cloudflare");
    await flush();

    expect(wrapper.find('[data-testid="refresh-error"]').text()).toContain(
      "Cloudflare answered 500",
    );
    expect(wrapper.find('[data-testid="policy-stale"]').exists()).toBe(true);
  });

  it("warns when the policy copy is stale or errored", async () => {
    const me = makeMe();
    me.policy = { ...me.policy!, stale: true, lastError: "token rejected" };
    const { wrapper } = await mountPage(buildApi(), me);

    expect(wrapper.find('[data-testid="policy-stale"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="policy-card"]').text()).toContain("token rejected");
  });

  it("shows setup instructions instead when the policy is not configured", async () => {
    const me = makeMe();
    me.policy = { configured: false, fetchedAt: null, stale: true, editUrl: null };
    const { wrapper } = await mountPage(buildApi(), me);
    const card = wrapper.find('[data-testid="policy-card"]');

    expect(card.text()).toContain("Amber is admin-only");
    expect(card.text()).toContain("CF_API_TOKEN");
    expect(card.text()).toContain("Access: Apps and Policies Read");
    expect(card.text()).toContain("CF_ACCOUNT_ID");
    expect(card.text()).toContain("CF_ACCESS_POLICY_ID");
    expect(findButton(wrapper, "Refresh from Cloudflare")).toBeUndefined();
    expect(wrapper.find('a[href^="https://dash.cloudflare.com/"]').exists()).toBe(false);
  });
});

describe("page states", () => {
  it("shows the error with a retry when users cannot be loaded", async () => {
    const api = buildApi({
      listUsers: vi
        .fn()
        .mockRejectedValue(
          new ApiClientError("forbidden", "Only the Amber admin can do that.", 403),
        ),
    });
    const { wrapper } = await mountPage(api);
    expect(wrapper.text()).toContain("Only the Amber admin can do that.");
    expect(findButton(wrapper, "Try again")).toBeDefined();
  });
});
