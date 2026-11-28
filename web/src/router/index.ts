import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteRecordRaw,
  type Router,
} from "vue-router";
import ReposPage from "../pages/ReposPage.vue";
import { useMeStore, type Requirement } from "../stores/me.ts";

declare module "vue-router" {
  interface RouteMeta {
    title?: string;
    /**
     * What the caller needs to use the page: one requirement, or a list of
     * which any one is enough. Only decides what the UI offers; the API
     * enforces the same rule on every call.
     */
    requires?: Requirement | Requirement[];
  }
}

/**
 * Repos is the landing route, so it is bundled eagerly. Every other page is a
 * dynamic import: the settings editor, the import preview, and the account
 * forms each pull in PrimeVue components nobody needs to download to look at a
 * repository list.
 */
export const routes: RouteRecordRaw[] = [
  { path: "/", name: "repos", component: ReposPage, meta: { title: "Repos" } },
  {
    path: "/removed",
    name: "removed",
    component: () => import("../pages/RemovedPage.vue"),
    meta: { title: "Removed", requires: "view_removed" },
  },
  {
    path: "/import",
    name: "import",
    component: () => import("../pages/ImportPage.vue"),
    meta: { title: "Import", requires: "import" },
  },
  {
    path: "/accounts",
    name: "accounts",
    component: () => import("../pages/AccountsPage.vue"),
    meta: { title: "Forges & Accounts", requires: ["import_private", "manage_forges"] },
  },
  {
    path: "/account-sync",
    name: "account-sync",
    component: () => import("../pages/AccountSyncPage.vue"),
    meta: { title: "Account Sync", requires: "import" },
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("../pages/SettingsPage.vue"),
    meta: { title: "Settings", requires: "manage_settings" },
  },
  {
    path: "/git-remote",
    name: "git-remote",
    component: () => import("../pages/GitRemotePage.vue"),
    meta: { title: "Git Remote", requires: "git" },
  },
  {
    path: "/users",
    name: "users",
    component: () => import("../pages/UsersPage.vue"),
    meta: { title: "Users", requires: "admin" },
  },
  {
    path: "/about",
    name: "about",
    component: () => import("../pages/AboutPage.vue"),
    meta: { title: "About" },
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export interface NavLink {
  to: string;
  label: string;
  /** AppIcon name. */
  icon: string;
  /** Hidden from callers who do not meet it. */
  requires?: Requirement | Requirement[];
}

/** Sidebar navigation, in display order. */
export const NAV_LINKS: NavLink[] = [
  { to: "/", label: "Repos", icon: "repos" },
  { to: "/removed", label: "Removed", icon: "removed", requires: "view_removed" },
  { to: "/import", label: "Import", icon: "import", requires: "import" },
  {
    to: "/accounts",
    label: "Forges & Accounts",
    icon: "accounts",
    requires: ["import_private", "manage_forges"],
  },
  { to: "/account-sync", label: "Account Sync", icon: "sync", requires: "import" },
  { to: "/settings", label: "Settings", icon: "settings", requires: "manage_settings" },
  { to: "/git-remote", label: "Git Remote", icon: "remote", requires: "git" },
  { to: "/users", label: "Users", icon: "users", requires: "admin" },
  { to: "/about", label: "About", icon: "about" },
];

/**
 * True when the caller may use the page. Until identity is known nothing is
 * refused here: the app shell shows its own screen while it loads and for the
 * two refusal states, and a page that is not allowed is left once it loads.
 */
export function routeAllowed(to: RouteLocationNormalized, me = useMeStore()): boolean {
  if (!me.ready) return true;
  return to.matched.every((record) => me.meets(record.meta.requires));
}

/** Send a caller away from a page they cannot use, to the landing page. */
export function installAccessGuard(target: Router): void {
  target.beforeEach((to) => (routeAllowed(to) ? true : { path: "/", replace: true }));
}

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
installAccessGuard(router);
