import type { AccountSync } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { notImplemented } from "../notImplemented.ts";
import type { AccountSyncProvider } from "./types.ts";

export function providerForKind(_kind: string): AccountSyncProvider | undefined {
  return notImplemented("providerForKind");
}

/** One account-sync run: enumerate via the provider, then upsert repos. */
export function runAccountSync(_db: Db, _accountSyncId: number): Promise<AccountSync> {
  return notImplemented("runAccountSync");
}
