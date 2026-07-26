import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import AboutPage from "../pages/AboutPage.vue";
import AccountSyncPage from "../pages/AccountSyncPage.vue";
import AccountsPage from "../pages/AccountsPage.vue";
import GitRemotePage from "../pages/GitRemotePage.vue";
import ImportPage from "../pages/ImportPage.vue";
import ReposPage from "../pages/ReposPage.vue";
import SettingsPage from "../pages/SettingsPage.vue";

export const routes: RouteRecordRaw[] = [
  { path: "/", name: "repos", component: ReposPage, meta: { title: "Repos" } },
  { path: "/import", name: "import", component: ImportPage, meta: { title: "Import" } },
  { path: "/accounts", name: "accounts", component: AccountsPage, meta: { title: "Accounts" } },
  {
    path: "/account-sync",
    name: "account-sync",
    component: AccountSyncPage,
    meta: { title: "Account Sync" },
  },
  { path: "/settings", name: "settings", component: SettingsPage, meta: { title: "Settings" } },
  {
    path: "/git-remote",
    name: "git-remote",
    component: GitRemotePage,
    meta: { title: "Git Remote" },
  },
  { path: "/about", name: "about", component: AboutPage, meta: { title: "About" } },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export interface NavLink {
  to: string;
  label: string;
}

/** Header navigation, in display order. */
export const NAV_LINKS: NavLink[] = [
  { to: "/", label: "Repos" },
  { to: "/import", label: "Import" },
  { to: "/accounts", label: "Accounts" },
  { to: "/account-sync", label: "Account Sync" },
  { to: "/settings", label: "Settings" },
  { to: "/git-remote", label: "Git Remote" },
  { to: "/about", label: "About" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
