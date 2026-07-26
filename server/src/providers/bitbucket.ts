import { notImplemented } from "../notImplemented.ts";
import type { AccountSyncProvider, DiscoveredRepo, DiscoveryContext } from "./types.ts";

export const bitbucketProvider: AccountSyncProvider = {
  kind: "bitbucket",
  listRepos(_context: DiscoveryContext): Promise<DiscoveredRepo[]> {
    return notImplemented("Bitbucket listRepos");
  },
};
