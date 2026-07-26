import type { CreateForge, Forge, ForgeKind, UpdateForge } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { notImplemented } from "../notImplemented.ts";

/** github.com -> github, gitlab.com -> gitlab, bitbucket.org -> bitbucket. */
export function detectForgeKind(_host: string): ForgeKind {
  return notImplemented("detectForgeKind");
}

export function listForges(_db: Db): Forge[] {
  return notImplemented("listForges");
}

export function getForge(_db: Db, _id: number): Forge | undefined {
  return notImplemented("getForge");
}

/** Idempotent: returns the existing forge when protocol+host+port already exist. */
export function upsertForge(_db: Db, _input: CreateForge): Forge {
  return notImplemented("upsertForge");
}

export function updateForge(_db: Db, _id: number, _patch: UpdateForge): Forge {
  return notImplemented("updateForge");
}

export function deleteForge(_db: Db, _id: number): void {
  return notImplemented("deleteForge");
}
