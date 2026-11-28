import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Select from "primevue/select";
import Tabs from "primevue/tabs";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Me } from "@amber/shared";
import ReposPage from "../src/pages/ReposPage.vue";
import AccountsPage from "../src/pages/AccountsPage.vue";
import AccountSyncPage from "../src/pages/AccountSyncPage.vue";
import ImportPage from "../src/pages/ImportPage.vue";
import RepoDetailDrawer from "../src/components/RepoDetailDrawer.vue";
import {
  forgeFailureSummary,
  hostNotAllowedLabel,
  importFailureKind,
  importFailureLabel,
} from "../src/lib/format.ts";
import { ApiClientError } from "../src/api/client.ts";
import { routes } from "../src/router/index.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import {
  makeAccount,
  makeAccountSync,
  makeForge,
  makeMe,
  makeNobody,
  makeRepo,
  makeUser,
  makeUserRow,
  stubApi,
} from "./helpers/stubApi.ts";

type AnyWrapper = ReturnType<typeof mount>;

// -- Repos list ---------------------------------------------------------------

const OWNED = makeRepo({
  id: 1,
  displayName: "mine",
  path: "me/mine",
  mine: true,
  isPrivate: true,
});
const THEIRS = makeRepo({
  id: 2,
  displayName: "theirs",
  path: "them/theirs",
  mine: false,
  isPrivate: false,
  owner: { id: 3, email: "gone@example.com", removed: true },
});

function reposApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    listRepos: vi.fn().mockResolvedValue({ rows: [OWNED, THEIRS], total: 2, page: 1, perPage: 25 }),
    listForges: vi.fn().mockResolvedValue([makeForge()]),
    listUsers: vi
      .fn()
      .mockResolvedValue([makeUserRow({ id: 3, email: "gone@example.com", removedAt: 5 })]),
    ...overrides,
  } as never);
}

async function mountRepos(api = reposApi(), me?: Me) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/");
  await router.isReady();
  const wrapper = mount(ReposPage, { global: mountGlobals({ api, router, me }) });
  await flush();
  return { wrapper, api };
}

function lastQuery(api: ReturnType<typeof stubApi>): Record<string, unknown> {
  const calls = (api.listRepos as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

describe("repos list ownership", () => {
  it("shows the Owner column to the admin, with a removed tag", async () => {
    const { wrapper } = await mountRepos();
    const cells = wrapper.findAll('[data-testid="owner-cell"]');
    expect(cells).toHaveLength(1);
    expect(cells[0]?.text()).toContain("gone@example.com");
    expect(cells[0]?.text()).toContain("removed");
    expect(wrapper.findAll("th").map((th) => th.text())).toContain("Owner");
  });

  it("does not show the Owner column or the admin filters to a user", async () => {
    const { wrapper, api } = await mountRepos(reposApi(), makeUser());
    expect(wrapper.findAll("th").map((th) => th.text())).not.toContain("Owner");
    expect(wrapper.find('[data-testid="owner-cell"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Owner removed");
    expect(wrapper.find("#repo-owner").exists()).toBe(false);
    // The users list is admin-only and is never requested.
    expect(api.listUsers).not.toHaveBeenCalled();
  });

  it("offers Mine to everyone and sends mine=true", async () => {
    const { wrapper, api } = await mountRepos(reposApi(), makeUser());
    expect(wrapper.find("#repo-mine").exists()).toBe(true);

    await wrapper.find("#repo-mine").setValue(true);
    await flush();

    expect(lastQuery(api)).toMatchObject({ mine: true });
    expect(lastQuery(api)).not.toHaveProperty("ownerId");
  });

  it("sends ownerRemoved for the admin's Owner removed toggle", async () => {
    const { wrapper, api } = await mountRepos();
    await wrapper.find("#repo-owner-removed").setValue(true);
    await flush();
    expect(lastQuery(api)).toMatchObject({ ownerRemoved: true });
  });

  it("filters by owner from the users list, for the admin", async () => {
    const { wrapper, api } = await mountRepos();
    const select = wrapper
      .findAllComponents(Select)
      .find((entry) => entry.props("inputId") === "repo-owner");
    expect(select?.props("options")).toEqual([
      { label: "Any owner", value: null },
      { label: "gone@example.com (removed)", value: 3 },
    ]);

    select?.vm.$emit("update:modelValue", 3);
    await flush();

    expect(lastQuery(api)).toMatchObject({ ownerId: 3 });
  });

  it("never sends the admin-only filters for a user", async () => {
    const { wrapper, api } = await mountRepos(reposApi(), makeUser());
    await wrapper.find("#repo-mine").setValue(true);
    await flush();
    expect(Object.keys(lastQuery(api))).not.toContain("ownerRemoved");
  });

  it("marks each repository private or public", async () => {
    const { wrapper } = await mountRepos();
    const tags = wrapper.findAll('[data-testid="visibility"]').map((tag) => tag.text());
    expect(tags).toEqual(["private", "public"]);
  });
});

// -- Drawer -------------------------------------------------------------------

const FORGE = makeForge({ id: 1, host: "github.com", kind: "github" });
const ACCOUNTS = [makeAccount({ id: 1, forgeId: 1, username: "pmaxhogan", ownerUserId: 1 })];

async function mountDrawer(me: Me, repo = OWNED) {
  const api = stubApi({
    getEffectiveSettings: vi.fn().mockResolvedValue({}),
    getGitRemote: vi.fn().mockResolvedValue({
      enabled: true,
      username: "abc",
      hasPassword: true,
      rotatedAt: 1,
      cloneUrlTemplate: "https://abc:{password}@amber.example.com/git/{slug}.git",
    }),
  });
  const wrapper = mount(RepoDetailDrawer, {
    props: { repo, visible: true, forges: [FORGE], accounts: ACCOUNTS },
    global: mountGlobals({ api, me }),
  });
  await flush();
  return { wrapper, api };
}

function tabLabels(wrapper: AnyWrapper): string[] {
  return wrapper.findAll("[role=tab]").map((tab) => tab.text());
}

describe("repo drawer gating", () => {
  it("shows an owner everything their permissions allow", async () => {
    const { wrapper } = await mountDrawer(makeUser({ browse: true, export: true, git: true }), {
      ...OWNED,
    });
    expect(tabLabels(wrapper)).toEqual([
      "Overview",
      "History",
      "Settings",
      "Export",
      "Clone",
      "Browse",
    ]);
    expect(findButton(wrapper, "Sync now")).toBeDefined();
    expect(findButton(wrapper, "Delete")).toBeDefined();
  });

  it("hides sync, pause, delete and Settings on someone else's repo without modify_others", async () => {
    const { wrapper } = await mountDrawer(makeUser(), THEIRS);
    expect(findButton(wrapper, "Sync now")).toBeUndefined();
    expect(findButton(wrapper, "Pause")).toBeUndefined();
    expect(findButton(wrapper, "Delete")).toBeUndefined();
    expect(tabLabels(wrapper)).not.toContain("Settings");
  });

  it("shows them with modify_others, but leaves the account override to the owner", async () => {
    const { wrapper } = await mountDrawer(makeUser({ modify_others: true }), THEIRS);
    expect(findButton(wrapper, "Sync now")).toBeDefined();
    expect(tabLabels(wrapper)).toContain("Settings");
    const override = wrapper
      .findAllComponents(Select)
      .find((entry) => entry.props("inputId") === "repo-account-override");
    expect(override?.props("disabled")).toBe(true);
    expect(wrapper.text()).toContain("Only the owner can pick which account");
  });

  it("lets the admin edit the account override on anyone's repo", async () => {
    const { wrapper } = await mountDrawer(makeMe(), THEIRS);
    const override = wrapper
      .findAllComponents(Select)
      .find((entry) => entry.props("inputId") === "repo-account-override");
    expect(override?.props("disabled")).toBe(false);
  });

  it("hides Export, Clone and Browse without their permissions", async () => {
    const none = Object.fromEntries(
      ["browse", "export", "git"].map((key) => [key, false]),
    ) as Record<string, boolean>;
    const { wrapper } = await mountDrawer(makeUser(none), OWNED);
    expect(tabLabels(wrapper)).toEqual(["Overview", "History", "Settings"]);
  });

  it("shows the clone template with {password} left for the user to fill in", async () => {
    const { wrapper } = await mountDrawer(makeUser({ git: true }), OWNED);
    await wrapper.findComponent(Tabs).vm.$emit("update:value", "clone");
    await flush();
    const values = wrapper
      .findAll(".copy-field__input")
      .map((input) => (input.element as HTMLInputElement).value);
    expect(values[0]).toContain("{password}");
    expect(values[0]).toContain(OWNED.slug);
  });
});

// -- Accounts -----------------------------------------------------------------

const MINE = makeAccount({
  id: 1,
  username: "mine-bot",
  ownerUserId: 2,
  ownerEmail: "friend@example.com",
  isDefault: true,
});
const OTHERS = makeAccount({
  id: 2,
  username: "theirs-bot",
  ownerUserId: 9,
  ownerEmail: "other@example.com",
  isDefault: false,
});

async function mountAccounts(me: Me, accounts = [MINE, OTHERS]) {
  const api = stubApi({
    listForges: vi.fn().mockResolvedValue([makeForge({ id: 1 })]),
    listAccounts: vi.fn().mockResolvedValue(accounts),
    listRepos: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, perPage: 1 }),
  });
  const wrapper = mount(AccountsPage, { global: mountGlobals({ api, me }) });
  await flush();
  return { wrapper, api };
}

describe("accounts page gating", () => {
  it("shows an owner column when the API sent owner emails", async () => {
    const { wrapper } = await mountAccounts(makeUser({ manage_forges: true }));
    expect(wrapper.findAll('[data-testid="account-owner"]').map((cell) => cell.text())).toEqual([
      "friend@example.com",
      "other@example.com",
    ]);
  });

  it("shows no owner column when rows carry none", async () => {
    const plain = makeAccount({ id: 1, username: "solo" });
    const { wrapper } = await mountAccounts(makeUser({ import_private: true }), [plain]);
    expect(wrapper.find('[data-testid="account-owner"]').exists()).toBe(false);
  });

  it("lets manage_forges delete another user's account but not edit or default it", async () => {
    const { wrapper } = await mountAccounts(makeUser({ manage_forges: true }));
    const rows = wrapper.findAll(".account-table tbody tr");
    const theirs = rows[1];
    expect(findButton(theirs as never, "Delete")).toBeDefined();
    expect(findButton(theirs as never, "Edit")).toBeUndefined();
    expect(findButton(theirs as never, "Make default")).toBeUndefined();
  });

  it("gives import_private alone its own accounts but no forge controls", async () => {
    const { wrapper } = await mountAccounts(makeUser({ import_private: true }), [MINE]);
    expect(findButton(wrapper, "Add account")).toBeDefined();
    expect(findButton(wrapper, "Add forge")).toBeUndefined();
    expect(findButton(wrapper, "Remove forge")).toBeUndefined();
    expect(
      wrapper.findAllComponents(Select).some((s) => s.props("inputId") === "forge-kind-1"),
    ).toBe(false);
  });

  it("gives manage_forges the forge controls but not Add account without import_private", async () => {
    const { wrapper } = await mountAccounts(makeUser({ manage_forges: true }), [MINE]);
    expect(findButton(wrapper, "Add forge")).toBeDefined();
    expect(findButton(wrapper, "Remove forge")).toBeDefined();
    expect(findButton(wrapper, "Add account")).toBeUndefined();
  });

  it("offers the private-network switch to the admin and sends it when on", async () => {
    const { wrapper, api } = await mountAccounts(makeMe(), [MINE]);
    (api.createForge as ReturnType<typeof vi.fn>).mockResolvedValue(makeForge());
    await clickButton(wrapper, "Add forge");
    await flush();
    expect(wrapper.text()).toContain("Allow requests to private network addresses");

    await wrapper.find("#forge-host").setValue("git.example.com");
    await wrapper.find("#forge-private-network").setValue(true);
    await clickButton(wrapper, "Create forge");
    await flush();

    expect(api.createForge).toHaveBeenCalledWith(
      expect.objectContaining({ host: "git.example.com", allowPrivateNetwork: true }),
    );
  });

  it("does not offer the switch to a manage_forges user, and never sends it", async () => {
    const { wrapper, api } = await mountAccounts(makeUser({ manage_forges: true }), [MINE]);
    (api.createForge as ReturnType<typeof vi.fn>).mockResolvedValue(makeForge());
    await clickButton(wrapper, "Add forge");
    await flush();
    expect(wrapper.text()).not.toContain("Allow requests to private network addresses");

    await wrapper.find("#forge-host").setValue("git.example.com");
    await clickButton(wrapper, "Create forge");
    await flush();

    const [input] = (api.createForge as ReturnType<typeof vi.fn>).mock.calls[0] as [object];
    expect(input).not.toHaveProperty("allowPrivateNetwork");
  });
});

// -- Account sync -------------------------------------------------------------

async function mountSyncs(me: Me, syncs = [makeAccountSync({ id: 1, ownerUserId: 2 })]) {
  const api = stubApi({
    listAccountSyncs: vi.fn().mockResolvedValue(syncs),
    listAccounts: vi.fn().mockResolvedValue([makeAccount({ id: 1, ownerUserId: 2 })]),
    listForges: vi.fn().mockResolvedValue([makeForge({ id: 1 })]),
  });
  const wrapper = mount(AccountSyncPage, { global: mountGlobals({ api, me }) });
  await flush();
  return { wrapper, api };
}

describe("account sync gating", () => {
  it("lets the owner run, edit and delete their sync", async () => {
    const { wrapper } = await mountSyncs(makeUser({ import_private: true }));
    expect(findButton(wrapper, "Run now")).toBeDefined();
    expect(findButton(wrapper, "Edit")).toBeDefined();
    expect(findButton(wrapper, "Delete")).toBeDefined();
  });

  it("withholds trending controls without manage_settings", async () => {
    const trending = makeAccountSync({
      id: 5,
      source: "trending",
      accountId: null,
      topN: 10,
      windowDays: 1,
      ownerUserId: 2,
    });
    const without = await mountSyncs(makeUser(), [trending]);
    expect(findButton(without.wrapper, "Run now")).toBeUndefined();
    expect(findButton(without.wrapper, "Delete")).toBeUndefined();

    const withIt = await mountSyncs(makeUser({ manage_settings: true }), [trending]);
    expect(findButton(withIt.wrapper, "Run now")).toBeDefined();
  });

  it("shows the owner on a sync to the admin and lets them control it", async () => {
    const { wrapper } = await mountSyncs(makeMe(), [
      makeAccountSync({ id: 1, ownerUserId: 9, ownerEmail: "other@example.com" }),
    ]);
    expect(wrapper.find('[data-testid="sync-owner"]').text()).toContain("other@example.com");
    expect(findButton(wrapper, "Run now")).toBeDefined();
  });
});

// -- Import -------------------------------------------------------------------

describe("import failures", () => {
  it("names each failure kind and keeps the server's message", async () => {
    const results = [
      {
        line: "a",
        lineNumber: 1,
        status: "ok" as const,
        action: "failed" as const,
        message: "This host is not enabled on this Amber",
        code: "host_not_enabled",
      },
      {
        line: "b",
        lineNumber: 2,
        status: "ok" as const,
        action: "failed" as const,
        message: "You have reached your storage limit",
        code: "storage_cap_reached",
      },
      {
        line: "c",
        lineNumber: 3,
        status: "ok" as const,
        action: "failed" as const,
        message: "Amber could not import this repository",
      },
      { line: "d", lineNumber: 4, status: "ok" as const, action: "created" as const },
    ];
    const api = stubApi({
      previewImport: vi.fn().mockResolvedValue({
        results: [{ line: "a", lineNumber: 1, status: "ok" }],
        summary: { total: 1, ok: 1, warning: 0, error: 0 },
      }),
      commitImport: vi.fn().mockResolvedValue({ results, created: 1, updated: 0, failed: 3 }),
    });
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/import");
    await router.isReady();
    const wrapper = mount(ImportPage, { global: mountGlobals({ api, router }) });
    await flush();

    await wrapper.find("#import-text").setValue("x");
    await clickButton(wrapper, "Preview");
    await flush();
    await clickButton(wrapper, "Import 1");
    await flush();

    const failures = wrapper.findAll('[data-testid="import-failure"]').map((cell) => cell.text());
    expect(failures).toEqual([
      "Host not enabledThis host is not enabled on this Amber",
      "Storage limit reachedYou have reached your storage limit",
      "Could not importAmber could not import this repository",
    ]);
  });

  it("classifies by code first, then falls back to the message", () => {
    expect(importFailureKind("host_not_enabled", "anything")).toBe("host_not_enabled");
    expect(importFailureKind("storage_cap_reached")).toBe("storage_cap_reached");
    // A domain error code is not one the page names, whatever the wording says.
    expect(importFailureKind("forbidden", "This host is not enabled")).toBe("not_imported");
    expect(importFailureKind(undefined, "This host is not enabled on this Amber")).toBe(
      "host_not_enabled",
    );
    expect(importFailureKind(undefined, "You are at your storage cap")).toBe("storage_cap_reached");
    expect(importFailureKind(undefined, undefined)).toBe("not_imported");
    expect(importFailureKind(undefined, "Amber could not import this repository")).toBe(
      "not_imported",
    );
  });

  it("names a host_not_allowed refusal and its egress reason", () => {
    expect(importFailureKind("host_not_allowed", "x")).toBe("host_not_allowed");
    expect(importFailureLabel({ code: "host_not_allowed", reason: "port" })).toBe(
      "Host not allowed: non-standard port",
    );
    expect(importFailureLabel({ code: "host_not_allowed", reason: "not_public" })).toBe(
      "Host not allowed: private network address",
    );
    for (const reason of ["scheme", "ip_literal", "invalid_host", "unresolvable"]) {
      expect(hostNotAllowedLabel(reason)).toMatch(/^Host not allowed: \S/);
    }
    // An unknown or missing reason still gets the specific label, not the generic one.
    expect(importFailureLabel({ code: "host_not_allowed", reason: "brand_new" })).toBe(
      "Host not allowed",
    );
    expect(importFailureLabel({ code: "host_not_allowed" })).toBe("Host not allowed");
    expect(importFailureLabel({ code: "storage_cap_reached" })).toBe("Storage limit reached");

    const refused = new ApiClientError("host_not_allowed", "nope", 403, { reason: "ip_literal" });
    expect(forgeFailureSummary("Could not add the forge", refused)).toBe(
      "Host not allowed: IP address, not a host name",
    );
    expect(forgeFailureSummary("Could not add the forge", new Error("x"))).toBe(
      "Could not add the forge",
    );
  });

  it("shows an already-backed-up line as neutral, not as a failure", async () => {
    const api = stubApi({
      previewImport: vi.fn().mockResolvedValue({
        results: [{ line: "a", lineNumber: 1, status: "ok" }],
        summary: { total: 1, ok: 1, warning: 0, error: 0 },
      }),
      commitImport: vi.fn().mockResolvedValue({
        results: [
          {
            line: "a",
            lineNumber: 1,
            status: "ok",
            action: "updated",
            message: "Already backed up. Nothing was changed.",
          },
        ],
        created: 0,
        updated: 1,
        failed: 0,
      }),
    });
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/import");
    await router.isReady();
    const wrapper = mount(ImportPage, { global: mountGlobals({ api, router }) });
    await flush();
    await wrapper.find("#import-text").setValue("x");
    await clickButton(wrapper, "Preview");
    await flush();
    await clickButton(wrapper, "Import 1");
    await flush();

    expect(wrapper.findAll('[data-testid="import-failure"]')).toHaveLength(0);
    expect(wrapper.find(".chip--error").text()).toBe("0 failed");
    expect(wrapper.find(".import-row--updated").exists()).toBe(true);
    expect(wrapper.text()).toContain("Already backed up. Nothing was changed.");
  });
});

describe("a user with nothing", () => {
  it("still loads the repo list and cannot reach any control", async () => {
    const { wrapper } = await mountRepos(reposApi(), makeNobody());
    expect(wrapper.find(".repos-page").exists()).toBe(true);
  });
});
