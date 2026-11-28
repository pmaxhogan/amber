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
import { canView } from "../security/authz.ts";
import { findOwnAccountByUsername } from "./accounts.ts";
import { ownerMayUseAccounts } from "./credentials.ts";
import { DomainError } from "./errors.ts";
import { findNamespaceSync, insertAccountSync } from "../providers/discovery.ts";
import {
  assertForgeAllowed,
  detectForgeKind,
  findForge,
  HOST_NOT_ENABLED_MESSAGE,
  mayAddForges,
  upsertForge,
  type ForgeOrigin,
} from "./forges.ts";
import { createRepo, normalizeRepoPath } from "./repos.ts";
import { isAtOrOverCap, type User } from "./users.ts";

/**
 * Bulk import, always on behalf of one IMPORTER, who owns everything the
 * import creates.
 *
 * - A `user@` prefix selects among the IMPORTER'S OWN accounts only, and only
 *   when they may use accounts at all (`import_private`). It never creates an
 *   account, and another user's account by that name reads exactly like none.
 *   Without `import_private` the line imports anonymously: none of that
 *   user's repositories ever resolves a credential (domain/credentials.ts).
 * - A forge+path Amber already has is never created twice and never changed:
 *   the importer can view it -> "already backed up"; they cannot -> the line
 *   fails with the same text an upstream that refuses them produces.
 * - A NEW host needs `manage_forges` or the admin, and passes the egress seam
 *   (assertForgeAllowed) before its forge row exists. Anyone else gets
 *   "this host is not enabled on this Amber".
 * - At or over the storage cap, a new repository is refused.
 *
 * A line that names a whole user or organization rather than a repository -
 * `https://github.com/nodejs`, one path segment on a forge whose provider can
 * enumerate namespaces - imports as a namespace sync owned by the importer.
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
  `You have no account named "${username}" on ${host}, so this repository was imported ` +
  `without an account override. Add the account first if it needs credentials.`;

const NO_ACCOUNT_NAMESPACE_MESSAGE = (username: string, host: string): string =>
  `You have no account named "${username}" on ${host}, so this namespace syncs with your ` +
  `default account there, if any. Add the account first if it needs other credentials.`;

const ANONYMOUS_MESSAGE =
  "Imported anonymously: using forge accounts needs the import_private permission, so the " +
  "account named in this line is not used.";

/** Exactly what an upstream that refuses the importer produces. */
export const COULD_NOT_IMPORT_MESSAGE = "Amber could not import this repository.";

export const ALREADY_BACKED_UP_MESSAGE = "Already backed up. Nothing was changed.";

export const STORAGE_CAP_MESSAGE =
  "You are at your storage cap, so new repositories cannot be added. Your existing ones " +
  "keep syncing.";

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

function originOf(parsed: ParsedRepoUrl): ForgeOrigin {
  return { protocol: parsed.protocol, host: parsed.host, port: parsed.port };
}

function originKey(origin: ForgeOrigin): string {
  return `${origin.protocol}://${origin.host.toLowerCase()}:${String(origin.port ?? "")}`;
}

function failLine(result: ImportLineResult, message: string, code?: string): ImportLineResult {
  return { ...result, status: "error", message, ...(code === undefined ? {} : { code }) };
}

/**
 * Warn when a user@ prefix names an account the importer does not have (or
 * may not use). Applied to both preview and commit so the preview table shows
 * exactly what will happen. Only the importer's own accounts are consulted.
 */
function checkAccountPrefix(db: Db, importer: User, result: ImportLineResult): ImportLineResult {
  const parsed = result.parsed;
  if (result.status === "error" || parsed === undefined || parsed.username === null) {
    return result;
  }
  if (!ownerMayUseAccounts(importer)) {
    return withWarning(result, ANONYMOUS_MESSAGE);
  }
  const forge = findForge(db, parsed.protocol, parsed.host, parsed.port);
  if (
    forge !== undefined &&
    findOwnAccountByUsername(db, importer.id, forge.id, parsed.username) !== undefined
  ) {
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

/** A line on a host Amber does not have fails up front unless the importer may add hosts. */
function checkHost(db: Db, importer: User, result: ImportLineResult): ImportLineResult {
  const parsed = result.parsed;
  if (result.status === "error" || parsed === undefined) {
    return result;
  }
  if (findForge(db, parsed.protocol, parsed.host, parsed.port) !== undefined) {
    return result;
  }
  return mayAddForges(importer)
    ? result
    : failLine(result, HOST_NOT_ENABLED_MESSAGE, "host_not_enabled");
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

/**
 * Pure parse plus account and host checks, no writes. Backed by
 * shared/src/importUrl.ts. It says nothing about repositories Amber already
 * has, so a preview is never a way to learn what other people back up.
 */
export function previewImport(db: Db, importer: User, text: string): ImportPreviewResponse {
  const results = parseImportText(text).map((result) =>
    redactResult(
      checkHost(db, importer, checkAccountPrefix(db, importer, classifyTarget(db, result))),
    ),
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
 * The new hosts this import would introduce, each put through the egress
 * seam BEFORE any forge row exists. Runs outside the commit transaction
 * because the seam may resolve DNS. A host the importer may not add, or that
 * the seam refuses, maps to the refusal its lines will carry.
 */
async function vetNewHosts(
  db: Db,
  importer: User,
  lines: readonly ImportLineResult[],
): Promise<Map<string, { message: string; code: string } | null>> {
  const verdicts = new Map<string, { message: string; code: string } | null>();
  for (const line of lines) {
    if (line.status === "error" || line.parsed === undefined) {
      continue;
    }
    const origin = originOf(line.parsed);
    const key = originKey(origin);
    if (
      verdicts.has(key) ||
      findForge(db, origin.protocol, origin.host, origin.port) !== undefined
    ) {
      continue;
    }
    if (!mayAddForges(importer)) {
      verdicts.set(key, { message: HOST_NOT_ENABLED_MESSAGE, code: "host_not_enabled" });
      continue;
    }
    try {
      await assertForgeAllowed(origin, importer, { allowPrivateNetwork: false });
      verdicts.set(key, null);
    } catch (error) {
      verdicts.set(
        key,
        error instanceof DomainError
          ? { message: error.message, code: error.code }
          : { message: HOST_NOT_ENABLED_MESSAGE, code: "host_not_enabled" },
      );
    }
  }
  return verdicts;
}

/**
 * Commit an import for `importer`. Idempotent: re-importing a repository
 * Amber already has changes nothing at all (not its owner, not its account
 * override, not its schedule). Only newly created repos are staggered.
 */
export async function commitImport(
  db: Db,
  importer: User,
  text: string,
  options: ImportOptions = {},
): Promise<ImportCommitResponse> {
  const now = options.now ?? Date.now();
  // Redact first, so nothing downstream can echo a pasted password.
  const parsedLines = parseImportText(text).map((line) => redactResult(classifyTarget(db, line)));
  const hostVerdicts = await vetNewHosts(db, importer, parsedLines);

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

    const refusal = hostVerdicts.get(originKey(originOf(line.parsed)));
    if (refusal !== undefined && refusal !== null) {
      results.push({ ...failLine(line, refusal.message, refusal.code), action: "failed" });
      failed += 1;
      continue;
    }

    try {
      if (line.target === "namespace") {
        const outcome = commitNamespaceLine(db, importer, line.parsed, now);
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

      const outcome = commitLine(db, importer, line.parsed, now + newIndex * step);
      if (outcome.action === "failed") {
        results.push({ ...failLine(line, outcome.message, outcome.code), action: "failed" });
        failed += 1;
        continue;
      }
      if (outcome.action === "created") {
        created += 1;
        newIndex += 1;
      } else {
        updated += 1;
      }
      const message = outcome.warning ?? outcome.note ?? line.message;
      results.push({
        ...line,
        status: outcome.warning === undefined ? "ok" : "warning",
        ...(message === undefined ? {} : { message }),
        action: outcome.action,
        repoId: outcome.repoId,
      });
    } catch (error) {
      const message =
        error instanceof DomainError ? error.message : "Could not import this repository.";
      const code = error instanceof DomainError ? error.code : undefined;
      results.push({ ...failLine(line, message, code), action: "failed" });
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
 * The importer's own account named by a `user@` prefix, when they may use
 * accounts and have one by that name; otherwise null with the warning that
 * explains why.
 */
function prefixAccount(
  db: Db,
  importer: User,
  forgeId: number,
  parsed: ParsedRepoUrl,
  noAccount: (username: string, host: string) => string,
): { accountId: number | null; warning: string | undefined } {
  if (parsed.username === null) {
    return { accountId: null, warning: undefined };
  }
  if (!ownerMayUseAccounts(importer)) {
    return { accountId: null, warning: ANONYMOUS_MESSAGE };
  }
  const account = findOwnAccountByUsername(db, importer.id, forgeId, parsed.username);
  return account === undefined
    ? { accountId: null, warning: noAccount(parsed.username, parsed.host) }
    : { accountId: account.id, warning: undefined };
}

/**
 * Idempotent like a repo line, per importer: importing a namespace the
 * importer already syncs updates their sync's account when a user@ prefix
 * names a different one of THEIR accounts, and never clears an account just
 * because this line carried no prefix. Another user's sync of the same
 * namespace is theirs and is never touched.
 */
function commitNamespaceLine(
  db: Db,
  importer: User,
  parsed: ParsedRepoUrl,
  now: number,
): NamespaceOutcome {
  return db.tx(() => {
    const forge = upsertForge(db, originOf(parsed));
    const { accountId, warning } = prefixAccount(
      db,
      importer,
      forge.id,
      parsed,
      NO_ACCOUNT_NAMESPACE_MESSAGE,
    );

    const existing = findNamespaceSync(db, importer.id, forge.id, parsed.path);
    if (existing !== undefined) {
      if (accountId !== null && accountId !== existing.account_id) {
        db.run(
          "UPDATE account_syncs SET account_id = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
          accountId,
          now,
          existing.id,
          importer.id,
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
        ownerUserId: importer.id,
      },
      now,
    );
    return { action: "created", accountSyncId: sync.id, warning };
  });
}

type LineOutcome =
  | {
      action: "created" | "updated";
      repoId: number;
      warning: string | undefined;
      /** Informational, not a warning: the line still succeeded cleanly. */
      note?: string;
    }
  | { action: "failed"; message: string; code?: string };

function commitLine(
  db: Db,
  importer: User,
  parsed: ParsedRepoUrl,
  nextSyncAt: number,
): LineOutcome {
  return db.tx((): LineOutcome => {
    const path = normalizeRepoPath(parsed.path);
    const known = findForge(db, parsed.protocol, parsed.host, parsed.port);
    if (known !== undefined) {
      const existing = db.get<{ id: number; owner_user_id: number | null; is_private: number }>(
        "SELECT id, owner_user_id, is_private FROM repos WHERE forge_id = ? AND path = ?",
        known.id,
        path,
      );
      if (existing !== undefined) {
        // Repos stay unique per forge and path and have one owner: a second
        // import never creates or changes anything. One the importer cannot
        // see answers exactly like an upstream that refused them.
        const visible = canView(importer, {
          ownerUserId: existing.owner_user_id,
          isPrivate: existing.is_private !== 0,
        });
        return visible
          ? {
              action: "updated",
              repoId: existing.id,
              warning: undefined,
              note: ALREADY_BACKED_UP_MESSAGE,
            }
          : { action: "failed", message: COULD_NOT_IMPORT_MESSAGE };
      }
    }

    if (isAtOrOverCap(db, importer)) {
      return { action: "failed", message: STORAGE_CAP_MESSAGE, code: "storage_cap_reached" };
    }

    const forge = known ?? upsertForge(db, originOf(parsed));
    const { accountId, warning } = prefixAccount(
      db,
      importer,
      forge.id,
      parsed,
      NO_ACCOUNT_MESSAGE,
    );

    const repo = createRepo(db, {
      forgeId: forge.id,
      path,
      accountOverrideId: accountId,
      nextSyncAt,
      ownerUserId: importer.id,
    });
    return { action: "created", repoId: repo.id, warning };
  });
}
