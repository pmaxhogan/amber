import { notImplemented } from "../notImplemented.ts";
import type { AccountSyncProvider, DiscoveredRepo, DiscoveryContext } from "./types.ts";

export const gitlabProvider: AccountSyncProvider = {
  kind: "gitlab",
  listRepos(_context: DiscoveryContext): Promise<DiscoveredRepo[]> {
    return notImplemented("GitLab listRepos");
  },
};
