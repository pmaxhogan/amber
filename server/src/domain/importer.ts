import type { ImportCommitResponse, ImportPreviewResponse } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { notImplemented } from "../notImplemented.ts";

/** Pure parse, no writes. Backed by shared/src/importUrl.ts. */
export function previewImport(_db: Db, _text: string): ImportPreviewResponse {
  return notImplemented("previewImport");
}

/**
 * Commit an import. Idempotent: re-importing an existing forge+path updates the
 * account override rather than erroring. Staggers first syncs across a few
 * minutes so a bulk import does not stampede.
 */
export function commitImport(_db: Db, _text: string): ImportCommitResponse {
  return notImplemented("commitImport");
}
