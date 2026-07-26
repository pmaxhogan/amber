import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import ReposPage from "../pages/ReposPage.vue";

/**
 * Repos is the landing route, so it is bundled eagerly. Every other page is a
 * dynamic import: the settings editor, the import preview, and the account
 * forms each pull in PrimeVue components nobody needs to download to look at a
 * repository list.
 */
export const routes: RouteRecordRaw[] = [
  { path: "/", name: "repos", component: ReposPage, meta: { title: "Repos" } },
  {
    path: "/import",
    name: "import",
    component: () => import("../pages/ImportPage.vue"),
    meta: { title: "Import" },
  },
  {
    path: "/accounts",
    name: "accounts",
    component: () => import("../pages/AccountsPage.vue"),
    meta: { title: "Forges & Accounts" },
  },
  {
    path: "/account-sync",
    name: "account-sync",
    component: () => import("../pages/AccountSyncPage.vue"),
    meta: { title: "Account Sync" },
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("../pages/SettingsPage.vue"),
    meta: { title: "Settings" },
  },
  {
    path: "/git-remote",
    name: "git-remote",
    component: () => import("../pages/GitRemotePage.vue"),
    meta: { title: "Git Remote" },
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
}

/** Sidebar navigation, in display order. */
export const NAV_LINKS: NavLink[] = [
  { to: "/", label: "Repos", icon: "repos" },
  { to: "/import", label: "Import", icon: "import" },
  { to: "/accounts", label: "Forges & Accounts", icon: "accounts" },
  { to: "/account-sync", label: "Account Sync", icon: "sync" },
  { to: "/settings", label: "Settings", icon: "settings" },
  { to: "/git-remote", label: "Git Remote", icon: "remote" },
  { to: "/about", label: "About", icon: "about" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
