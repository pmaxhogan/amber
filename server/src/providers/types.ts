import type { AccountSyncVisibility } from "@amber/shared";

/** One repository as returned by a forge API during account sync. */
export interface DiscoveredRepo {
  /** Normalized path, matching repos.path. */
  path: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  archived: boolean;
}

export interface DiscoveryContext {
  host: string;
  username: string;
  /** Decrypted just in time; never logged. */
  secret: string | null;
  visibility: AccountSyncVisibility;
}

export interface AccountSyncProvider {
  readonly kind: string;
  /** Enumerate every repository the account can see, honoring visibility. */
  listRepos(context: DiscoveryContext): Promise<DiscoveredRepo[]>;
}
