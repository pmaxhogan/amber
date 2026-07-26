import { notImplemented } from "../notImplemented.ts";
import type { AccountSyncProvider, DiscoveredRepo, DiscoveryContext } from "./types.ts";

export const giteaProvider: AccountSyncProvider = {
  kind: "gitea",
  listRepos(_context: DiscoveryContext): Promise<DiscoveredRepo[]> {
    return notImplemented("Gitea listRepos");
  },
};
