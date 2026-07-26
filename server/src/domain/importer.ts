import {
  parseImportText,
  summarizeImport,
  withWarning,
  type ImportCommitResponse,
  type ImportLineResult,
  type ImportPreviewResponse,
  type ParsedRepoUrl,
} from "@amber/shared";
import type { Db } from "../db/db.ts";
import { findAccountByUsername } from "./accounts.ts";
import { DomainError } from "./errors.ts";
import { findForge, upsertForge } from "./forges.ts";
import { createRepo, findRepoByPath, normalizeRepoPath } from "./repos.ts";

/**
 * Bulk import. Forges are created on demand, accounts never are: a `user@`
 * prefix can only select an account that already exists on that forge, and
 * otherwise the line imports with a warning and no override. Implicitly
 * creating a credential-less account would be a confusing half-state, and
 * silently attaching a credential the user did not intend would be worse.
 */

/** Spacing between the first syncs of newly imported repos. */
export const STAGGER_STEP_MS = 3_000;
/** The whole first wave lands inside this window, however many repos there are. */
export const MAX_STAGGER_WINDOW_MS = 5 * 60_000;

export interface ImportOptions {
  /** Injectable so staggering is deterministic in tests. */
  now?: number;
  staggerStepMs?: number;
}

const NO_ACCOUNT_MESSAGE = (username: string, host: string): string =>
  `No account named "${username}" exists on ${host}, so this repository was imported without ` +
  `an account override. Add the account first if it needs credentials.`;

/**
 * Warn when a user@ prefix names an account we do not have. Applied to both
 * preview and commit so the preview table shows exactly what will happen.
 */
function checkAccountPrefix(db: Db, result: ImportLineResult): ImportLineResult {
  const parsed = result.parsed;
  if (result.status === "error" || parsed === undefined || parsed.username === null) {
    return result;
  }
  const forge = findForge(db, parsed.protocol, parsed.host, parsed.port);
  if (forge !== undefined && findAccountByUsername(db, forge.id, parsed.username) !== undefined) {
    return result;
  }
  return withWarning(result, NO_ACCOUNT_MESSAGE(parsed.username, parsed.host));
}

/** Pure parse plus account matching, no writes. Backed by shared/src/importUrl.ts. */
export function previewImport(db: Db, text: string): ImportPreviewResponse {
  const results = parseImportText(text).map((result) => checkAccountPrefix(db, result));
  return { results, summary: summarizeImport(results) };
}

/** Evenly spread the first wave without exceeding the stagger window. */
export function staggerStepFor(count: number, step: number = STAGGER_STEP_MS): number {
  if (count <= 1) {
    return 0;
  }
  return Math.min(step, Math.floor(MAX_STAGGER_WINDOW_MS / (count - 1)));
}

type CommitResult = ImportCommitResponse["results"][number];

/**
 * Commit an import. Idempotent: re-importing an existing forge+path updates the
 * account override rather than erroring, and deliberately leaves that repo's
 * next_sync_at alone so a re-import does not reschedule healthy backups.
 * Only newly created repos are staggered.
 */
export function commitImport(
  db: Db,
  text: string,
  options: ImportOptions = {},
): ImportCommitResponse {
  const now = options.now ?? Date.now();
  const parsedLines = parseImportText(text);
  const importable = parsedLines.filter((line) => line.status !== "error").length;
  const step = staggerStepFor(importable, options.staggerStepMs ?? STAGGER_STEP_MS);

  const results: CommitResult[] = [];
  let created = 0;
  let updated = 0;
  let failed = 0;
  let newIndex = 0;

  for (const line of parsedLines) {
    if (line.status === "error" || line.parsed === undefined) {
      results.push({ ...line, status: "error", action: "failed" });
      failed += 1;
      continue;
    }

    try {
      const outcome = commitLine(db, line.parsed, now + newIndex * step);
      if (outcome.action === "created") {
        created += 1;
        newIndex += 1;
      } else {
        updated += 1;
      }
      const message = outcome.warning ?? line.message;
      results.push({
        ...line,
        status: message === undefined ? "ok" : "warning",
        ...(message === undefined ? {} : { message }),
        action: outcome.action,
        repoId: outcome.repoId,
      });
    } catch (error) {
      const message =
        error instanceof DomainError ? error.message : "Could not import this repository.";
      results.push({ ...line, status: "error", message, action: "failed" });
      failed += 1;
    }
  }

  return { results, created, updated, failed };
}

interface LineOutcome {
  action: "created" | "updated";
  repoId: number;
  warning: string | undefined;
}

function commitLine(db: Db, parsed: ParsedRepoUrl, nextSyncAt: number): LineOutcome {
  return db.tx(() => {
    const forge = upsertForge(db, {
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
    });

    // A user@ prefix selects an existing account. It never creates one.
    let overrideId: number | null = null;
    let warning: string | undefined;
    if (parsed.username !== null) {
      const account = findAccountByUsername(db, forge.id, parsed.username);
      if (account === undefined) {
        warning = NO_ACCOUNT_MESSAGE(parsed.username, parsed.host);
      } else {
        overrideId = account.id;
      }
    }

    const path = normalizeRepoPath(parsed.path);
    const existing = findRepoByPath(db, forge.id, path);

    if (existing !== undefined) {
      // Re-import updates the override when one was named, and never clears an
      // existing override just because this line carried no user@ prefix.
      if (overrideId !== null && overrideId !== existing.accountOverrideId) {
        const at = Date.now();
        db.run(
          "UPDATE repos SET account_override_id = ?, updated_at = ? WHERE id = ?",
          overrideId,
          at,
          existing.id,
        );
      }
      return { action: "updated", repoId: existing.id, warning };
    }

    const repo = createRepo(db, {
      forgeId: forge.id,
      path,
      accountOverrideId: overrideId,
      nextSyncAt,
    });
    return { action: "created", repoId: repo.id, warning };
  });
}
