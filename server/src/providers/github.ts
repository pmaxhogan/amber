import { notImplemented } from "../notImplemented.ts";
import type { AccountSyncProvider, DiscoveredRepo, DiscoveryContext } from "./types.ts";

export const githubProvider: AccountSyncProvider = {
  kind: "github",
  listRepos(_context: DiscoveryContext): Promise<DiscoveredRepo[]> {
    return notImplemented("GitHub listRepos");
  },
};
