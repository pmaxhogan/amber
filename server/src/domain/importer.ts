import {
  NAMESPACE_RE,
  parseImportText,
  summarizeImport,
  supportsNamespaceSyncKind,
  withWarning,
  type ImportCommitResponse,
  type ImportLineResult,
  type ImportPreviewResponse,
  type ParsedRepoUrl,
} from "@amber/shared";
import type { Db } from "../db/db.ts";
import { findAccountByUsername } from "./accounts.ts";
import { DomainError } from "./errors.ts";
import { findNamespaceSync, insertAccountSync } from "../providers/discovery.ts";
import { detectForgeKind, findForge, upsertForge } from "./forges.ts";
import { createRepo, findRepoByPath, normalizeRepoPath } from "./repos.ts";

/**
 * Bulk import. Forges are created on demand, accounts never are: a `user@`
 * prefix can only select an account that already exists on that forge, and
 * otherwise the line imports with a warning and no override. Implicitly
 * creating a credential-less account would be a confusing half-state, and
 * silently attaching a credential the user did not intend would be worse.
 *
 * A line that names a whole user or organization rather than a repository -
 * `https://github.com/nodejs`, one path segment on a forge whose provider can
 * enumerate namespaces - imports as a namespace sync instead: every repository
 * that namespace owns is discovered now and on every later run, so ones
 * created after the import arrive on their own. A `user@` prefix pins the sync
 * to that account; without one it follows the forge default account.
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

const NO_ACCOUNT_NAMESPACE_MESSAGE = (username: string, host: string): string =>
  `No account named "${username}" exists on ${host}, so this namespace syncs with the ` +
  `forge default account. Add the account first if it needs other credentials.`;

/** Matches the account-sync API default. */
const DEFAULT_NAMESPACE_INTERVAL_MINUTES = 360;

/**
 * Matches a `user:password@` in the authority, with or without a scheme, and
 * captures the password so it can be masked.
 */
const USERINFO_PASSWORD_RE = /^((?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?[^/?#@\s]*:)[^/?#@\s]*(@)/;

/**
 * Every import result echoes its input line so the preview table can show what
 * was parsed. A line like `https://user:hunter2@host/x` is rejected, but the
 * echo would still carry the password into an API response and from there into
 * browser memory and any request log. Mask it before the line goes anywhere.
 */
export function redactLine(line: string): string {
  return line.replace(
    USERINFO_PASSWORD_RE,
    (_match, head: string, at: string) => `${head}***${at}`,
  );
}

function redactResult<T extends ImportLineResult>(result: T): T {
  const line = redactLine(result.line);
  return line === result.line ? result : { ...result, line };
}

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
  // classifyTarget has already run, so a namespace line gets the warning its
  // commit will actually produce.
  const message =
    result.target === "namespace"
      ? NO_ACCOUNT_NAMESPACE_MESSAGE(parsed.username, parsed.host)
      : NO_ACCOUNT_MESSAGE(parsed.username, parsed.host);
  return withWarning(result, message);
}

const NAMESPACE_MESSAGE = (namespace: string, host: string): string =>
  `Syncs every repository ${namespace} owns on ${host}, including ones created later.`;

/**
 * Whether a parsed line names a namespace. Only the server can answer: it
 * hinges on the forge kind, which comes from the stored forge when there is
 * one and from host detection for a forge this import would create. On any
 * other kind a one-segment path stays a repository, since plenty of plain git
 * hosts serve `host/repo`.
 */
function isNamespaceLine(db: Db, parsed: ParsedRepoUrl): boolean {
  if (parsed.path.includes("/") || !NAMESPACE_RE.test(parsed.path)) {
    return false;
  }
  const forge = findForge(db, parsed.protocol, parsed.host, parsed.port);
  return supportsNamespaceSyncKind(forge?.kind ?? detectForgeKind(parsed.host));
}

/** Tag every importable line with what it will become. */
function classifyTarget(db: Db, result: ImportLineResult): ImportLineResult {
  const parsed = result.parsed;
  if (result.status === "error" || parsed === undefined) {
    return result;
  }
  if (!isNamespaceLine(db, parsed)) {
    return { ...result, target: "repo" };
  }
  return {
    ...result,
    target: "namespace",
    // A warning already explains the line; otherwise say what will happen.
    message: result.message ?? NAMESPACE_MESSAGE(parsed.path, parsed.host),
  };
}

/** Pure parse plus account matching, no writes. Backed by shared/src/importUrl.ts. */
export function previewImport(db: Db, text: string): ImportPreviewResponse {
  const results = parseImportText(text).map((result) =>
    redactResult(checkAccountPrefix(db, classifyTarget(db, result))),
  );
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
  // Redact first, so nothing downstream can echo a pasted password.
  const parsedLines = parseImportText(text).map((line) => redactResult(classifyTarget(db, line)));
  const importable = parsedLines.filter(
    (line) => line.status !== "error" && line.target === "repo",
  ).length;
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
      if (line.target === "namespace") {
        const outcome = commitNamespaceLine(db, line.parsed, now);
        if (outcome.action === "created") {
          created += 1;
        } else {
          updated += 1;
        }
        results.push({
          ...line,
          status: outcome.warning === undefined ? "ok" : "warning",
          message: outcome.warning ?? line.message,
          action: outcome.action,
          accountSyncId: outcome.accountSyncId,
        });
        continue;
      }

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

interface NamespaceOutcome {
  action: "created" | "updated";
  accountSyncId: number;
  warning: string | undefined;
}

/**
 * Idempotent like a repo line: importing a namespace that is already synced
 * updates its account when a user@ prefix names a different one, and never
 * clears an account just because this line carried no prefix.
 */
function commitNamespaceLine(db: Db, parsed: ParsedRepoUrl, now: number): NamespaceOutcome {
  return db.tx(() => {
    const forge = upsertForge(db, {
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
    });

    let accountId: number | null = null;
    let warning: string | undefined;
    if (parsed.username !== null) {
      const account = findAccountByUsername(db, forge.id, parsed.username);
      if (account === undefined) {
        warning = NO_ACCOUNT_NAMESPACE_MESSAGE(parsed.username, parsed.host);
      } else {
        accountId = account.id;
      }
    }

    const existing = findNamespaceSync(db, forge.id, parsed.path);
    if (existing !== undefined) {
      if (accountId !== null && accountId !== existing.account_id) {
        db.run(
          "UPDATE account_syncs SET account_id = ?, updated_at = ? WHERE id = ?",
          accountId,
          now,
          existing.id,
        );
      }
      return { action: "updated", accountSyncId: existing.id, warning };
    }

    const sync = insertAccountSync(
      db,
      {
        forgeId: forge.id,
        accountId,
        source: "namespace",
        namespace: parsed.path,
        visibility: "all",
        enabled: true,
        intervalMinutes: DEFAULT_NAMESPACE_INTERVAL_MINUTES,
      },
      now,
    );
    return { action: "created", accountSyncId: sync.id, warning };
  });
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
