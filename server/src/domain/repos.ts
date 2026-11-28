import { randomBytes } from "node:crypto";
import type {
  BulkRepoAction,
  Page,
  PaginationQuery,
  Repo,
  RepoListQuery,
  RepoOrigin,
  RepoSortField,
  RepoState,
  SyncErrorKind,
  SyncOutcome,
  SyncRun,
  UpdateRepo,
} from "@amber/shared";
import { parseImportLine } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { canView, hasPermission, isRepoOwner, visibleRepoSqlFilter } from "../security/authz.ts";
import {
  conflict,
  DomainError,
  forbidden,
  invalid,
  isUniqueViolation,
  notFound,
} from "./errors.ts";
import { requireForge } from "./forges.ts";
import { resolveSettingsForRepos } from "./settings.ts";
import { getUser, isAtOrOverCap, type User } from "./users.ts";

/**
 * `forge_id` is IMMUTABLE. A repo cannot be re-pointed at another forge, which
 * would let it inherit that forge's (or its override account's) credentials
 * for a host it was never registered against. `path` may be edited, because a
 * rename stays on the same host.
 */

interface RepoRow {
  id: number;
  forge_id: number;
  path: string;
  display_name: string;
  slug: string;
  short_id: string;
  account_override_id: number | null;
  force_anonymous: number;
  managed_by_account_sync_id: number | null;
  state: string;
  next_sync_at: number | null;
  consecutive_failures: number;
  last_sync_at: number | null;
  last_success_at: number | null;
  last_seen_at: number | null;
  gone_at: number | null;
  fork_parent: string | null;
  owner_gone: number | null;
  owner_checked_at: number | null;
  last_error: string | null;
  disk_usage_bytes: number | null;
  default_branch: string | null;
  last_fetch_head: string | null;
  origin: string;
  owner_user_id: number | null;
  is_private: number;
  created_at: number;
  updated_at: number;
}

const REPO_COLUMNS = `repos.id, repos.forge_id, repos.path, repos.display_name, repos.slug,
  repos.short_id, repos.account_override_id, repos.force_anonymous,
  repos.managed_by_account_sync_id, repos.state, repos.next_sync_at, repos.consecutive_failures,
  repos.last_sync_at, repos.last_success_at, repos.last_seen_at, repos.gone_at,
  repos.fork_parent, repos.owner_gone, repos.owner_checked_at, repos.last_error,
  repos.disk_usage_bytes, repos.default_branch, repos.last_fetch_head, repos.origin,
  repos.owner_user_id, repos.is_private, repos.created_at, repos.updated_at`;

/**
 * Whether the owner is gone too, as of this repo's current gone episode. A
 * repo that came back, or went gone again after the owner was last asked,
 * must not carry the old answer.
 */
function ownerGoneOf(row: RepoRow): boolean | null {
  if (row.gone_at === null || row.owner_gone === null) {
    return null;
  }
  if (row.owner_checked_at !== null && row.owner_checked_at < row.gone_at) {
    return null;
  }
  return row.owner_gone === 1;
}

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    forgeId: row.forge_id,
    path: row.path,
    displayName: row.display_name,
    slug: row.slug,
    shortId: row.short_id,
    accountOverrideId: row.account_override_id,
    forceAnonymous: row.force_anonymous === 1,
    managedByAccountSyncId: row.managed_by_account_sync_id,
    state: row.state as RepoState,
    nextSyncAt: row.next_sync_at,
    consecutiveFailures: row.consecutive_failures,
    lastSyncAt: row.last_sync_at,
    lastSuccessAt: row.last_success_at,
    lastSeenAt: row.last_seen_at,
    goneAt: row.gone_at,
    forkParent: row.fork_parent,
    ownerGone: ownerGoneOf(row),
    lastError: row.last_error,
    diskUsageBytes: row.disk_usage_bytes,
    defaultBranch: row.default_branch,
    lastFetchHead: row.last_fetch_head,
    origin: row.origin as RepoOrigin,
    isPrivate: row.is_private !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The fields that depend on who is asking: `mine` for everyone, and the
 * owner's identity for the admin only. Nobody else learns who owns a
 * repository they did not import.
 */
function viewerFields(
  row: RepoRow,
  viewer: User,
  owners: ReadonlyMap<number, User>,
): Pick<Repo, "mine" | "owner"> {
  const mine = row.owner_user_id !== null && row.owner_user_id === viewer.id;
  if (!viewer.isAdmin || row.owner_user_id === null) {
    return { mine };
  }
  const owner = owners.get(row.owner_user_id);
  return owner === undefined
    ? { mine }
    : { mine, owner: { id: owner.id, email: owner.email, removed: owner.removedAt !== null } };
}

/**
 * What a viewer who is neither the owner nor the admin reads instead of a
 * sync error. Non-null whenever there is an error, so the UI still shows that
 * the last sync failed.
 */
export const OWNER_ONLY_ERROR =
  "The last sync failed. The details are visible to the repository's owner.";

function isOwnerOrAdmin(ownerUserId: number | null, viewer: User): boolean {
  return viewer.isAdmin || (ownerUserId !== null && ownerUserId === viewer.id);
}

/**
 * Fields that were learned or chosen with the OWNER'S account: which of their
 * accounts is pinned, which of their account syncs manages the repo, and the
 * error text a fetch with their token produced (which can name private repos,
 * an account, or a token problem). Another viewer (view_others_* or
 * modify_others) sees the repo, never these.
 */
function ownerDerivedFields(
  row: RepoRow,
  viewer: User,
): Partial<Pick<Repo, "accountOverrideId" | "managedByAccountSyncId" | "lastError">> {
  if (isOwnerOrAdmin(row.owner_user_id, viewer)) {
    return {};
  }
  return {
    accountOverrideId: null,
    managedByAccountSyncId: null,
    lastError: row.last_error === null ? null : OWNER_ONLY_ERROR,
  };
}

/** The owners of a page of rows, for the admin's owner column. One read per distinct owner. */
function ownersOf(db: Db, rows: readonly RepoRow[], viewer: User): Map<number, User> {
  const out = new Map<number, User>();
  if (!viewer.isAdmin) {
    return out;
  }
  for (const id of new Set(rows.map((row) => row.owner_user_id))) {
    if (id === null) {
      continue;
    }
    const user = getUser(db, id);
    if (user !== undefined) {
      out.set(id, user);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity: short id, slug, path
// ---------------------------------------------------------------------------

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
export const SHORT_ID_LENGTH = 8;
/** 256 is not a multiple of 36; bytes at or above this bias the low digits. */
const REJECT_AT = 256 - (256 % BASE36.length);

/** 8 characters of base36 from crypto.randomBytes. Unique per repo. */
export function generateShortId(): string {
  let out = "";
  while (out.length < SHORT_ID_LENGTH) {
    for (const byte of randomBytes(SHORT_ID_LENGTH * 2)) {
      if (byte >= REJECT_AT) {
        continue;
      }
      out += BASE36[byte % BASE36.length];
      if (out.length === SHORT_ID_LENGTH) {
        break;
      }
    }
  }
  return out;
}

/** Keep directory names readable without letting them grow unbounded. */
const MAX_SLUG_BODY = 64;

/**
 * Disk directory name: sanitized path + "-" + short_id. The short id makes
 * collisions impossible regardless of how two paths sanitize, so the
 * sanitizer is free to be aggressive.
 */
export function buildSlug(path: string, shortId: string): string {
  const body = path
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, MAX_SLUG_BODY)
    .replace(/[-._]+$/, "");
  return `${body === "" ? "repo" : body}-${shortId}`;
}

/**
 * A slug becomes a directory name under BACKUPS_DIR and can drive a recursive
 * delete, so it is validated rather than trusted even though every slug in the
 * database was generated by buildSlug.
 */
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function isSafeSlug(slug: string): boolean {
  return (
    SAFE_SLUG_RE.test(slug) &&
    slug.length <= MAX_SLUG_BODY + SHORT_ID_LENGTH + 1 &&
    !slug.includes("..")
  );
}

export function assertSafeSlug(slug: string): string {
  if (!isSafeSlug(slug)) {
    throw invalid("Refusing to act on a repository with an unsafe directory name.");
  }
  return slug;
}

/** No leading or trailing slash, no trailing `.git`, no empty segments. */
export function normalizeRepoPath(path: string): string {
  const withoutDotGit = path.trim().replace(/\/+$/, "");
  const stripped =
    withoutDotGit.length >= 4 && withoutDotGit.slice(-4).toLowerCase() === ".git"
      ? withoutDotGit.slice(0, -4)
      : withoutDotGit;
  const segments = stripped.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw invalid("A repository path cannot contain relative segments.");
  }
  return segments.join("/");
}

export function displayNameFor(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * For each repo that is a fork, the id of the row that backs up its upstream on
 * the same forge, or null when amber does not track it. One query for the whole
 * set. The match ignores case because forges treat paths that way, while
 * repos.path keeps whatever spelling the import used. Repos that are not forks
 * are left out of the map.
 */
function forkParentRepoIds(
  db: Db,
  children: readonly RepoRow[],
  viewer?: User,
): Map<number, number | null> {
  const forks = children.filter((row) => row.fork_parent !== null);
  const found = new Map<number, number | null>();
  for (const row of forks) {
    found.set(row.id, null);
  }
  if (forks.length === 0) {
    return found;
  }
  const marks = forks.map(() => "?").join(", ");
  // A derived reference obeys visibility too: a parent the viewer cannot see
  // reads exactly like a parent Amber does not have.
  const visible =
    viewer === undefined ? { sql: "(1)", params: [] } : visibleRepoSqlFilter(viewer, "parent");
  const matches = db.all<{ child_id: number; parent_id: number }>(
    `SELECT child.id AS child_id, MIN(parent.id) AS parent_id
       FROM repos child
       JOIN repos parent
         ON parent.forge_id = child.forge_id
        AND parent.path = child.fork_parent COLLATE NOCASE
        AND parent.id <> child.id
        AND ${visible.sql}
      WHERE child.id IN (${marks})
      GROUP BY child.id`,
    ...visible.params,
    ...forks.map((row) => row.id),
  );
  for (const match of matches) {
    found.set(match.child_id, match.parent_id);
  }
  return found;
}

export function getRepo(db: Db, id: number): Repo | undefined {
  const row = db.get<RepoRow>(`SELECT ${REPO_COLUMNS} FROM repos WHERE repos.id = ?`, id);
  if (row === undefined) {
    return undefined;
  }
  const repo = toRepo(row);
  const parentId = forkParentRepoIds(db, [row]).get(row.id);
  // Only forks carry the key: the single read has to agree with the listing.
  return parentId === undefined ? repo : { ...repo, forkParentRepoId: parentId };
}

/**
 * The repo as `viewer` may see it: undefined when it does not exist OR the
 * viewer cannot view it, so the two are indistinguishable to the caller.
 */
export function getRepoFor(db: Db, id: number, viewer: User): Repo | undefined {
  const row = db.get<RepoRow>(`SELECT ${REPO_COLUMNS} FROM repos WHERE repos.id = ?`, id);
  if (
    row === undefined ||
    !canView(viewer, { ownerUserId: row.owner_user_id, isPrivate: row.is_private !== 0 })
  ) {
    return undefined;
  }
  const repo = {
    ...toRepo(row),
    ...ownerDerivedFields(row, viewer),
    ...viewerFields(row, viewer, ownersOf(db, [row], viewer)),
  };
  const parentId = forkParentRepoIds(db, [row], viewer).get(row.id);
  return parentId === undefined ? repo : { ...repo, forkParentRepoId: parentId };
}

/** getRepoFor, or the same 404 a nonexistent id gets. */
export function requireRepoFor(db: Db, id: number, viewer: User): Repo {
  const repo = getRepoFor(db, id, viewer);
  if (repo === undefined) {
    throw notFound("Repository", id);
  }
  return repo;
}

export function requireRepo(db: Db, id: number): Repo {
  const repo = getRepo(db, id);
  if (repo === undefined) {
    throw notFound("Repository", id);
  }
  return repo;
}

export function getRepoBySlug(db: Db, slug: string): Repo | undefined {
  // The git remote accepts an optional trailing `.git` on the clone URL.
  const normalized = slug.endsWith(".git") ? slug.slice(0, -4) : slug;
  const row = db.get<RepoRow>(`SELECT ${REPO_COLUMNS} FROM repos WHERE repos.slug = ?`, normalized);
  return row === undefined ? undefined : toRepo(row);
}

export function findRepoByPath(db: Db, forgeId: number, path: string): Repo | undefined {
  const row = db.get<RepoRow>(
    `SELECT ${REPO_COLUMNS} FROM repos WHERE repos.forge_id = ? AND repos.path = ?`,
    forgeId,
    path,
  );
  return row === undefined ? undefined : toRepo(row);
}

/**
 * Sort columns are looked up in this literal map rather than validated and
 * interpolated, so no user string can ever reach the SQL text. `dir` is mapped
 * the same way.
 */
const SORT_SQL: Readonly<Record<RepoSortField, string>> = {
  display_name: "repos.display_name COLLATE NOCASE",
  path: "repos.path COLLATE NOCASE",
  last_sync_at: "repos.last_sync_at",
  last_success_at: "repos.last_success_at",
  // Never-seen rows sort last either way, so ascending leads with the repo
  // that vanished longest ago rather than with imports still waiting to clone.
  last_seen_at: "repos.last_seen_at IS NULL, repos.last_seen_at",
  gone_at: "repos.gone_at IS NULL, repos.gone_at",
  // Non-forks and repos nobody has asked about yet sort last either way.
  fork_parent: "repos.fork_parent IS NULL, repos.fork_parent COLLATE NOCASE",
  disk_usage_bytes: "repos.disk_usage_bytes",
  next_sync_at: "repos.next_sync_at",
  created_at: "repos.created_at",
};

const DIR_SQL: Readonly<Record<"asc" | "desc", string>> = { asc: "ASC", desc: "DESC" };

/** The outcome of the most recent run, used by the `outcome` filter. */
const LAST_OUTCOME_SQL = `(
  SELECT sr.outcome FROM sync_runs sr
  WHERE sr.repo_id = repos.id
  ORDER BY sr.started_at DESC, sr.id DESC
  LIMIT 1
)`;

/** The error classification of that same run, null on a successful one. */
const LAST_ERROR_KIND_SQL = `(
  SELECT sr.error_kind FROM sync_runs sr
  WHERE sr.repo_id = repos.id
  ORDER BY sr.started_at DESC, sr.id DESC
  LIMIT 1
)`;

/** Escape the LIKE wildcards so a search for "100%" is not a match-anything. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * What a pasted repository URL names, when the search term is one. People
 * paste whatever is in the address bar or their clipboard, so this is far
 * more forgiving than import: any scheme (ssh:// and git:// included), scp
 * syntax (`git@host:owner/repo`), a `user@` prefix, a trailing `.git` or
 * slash, a query string or fragment, and extra page segments such as
 * `/tree/main` all reduce to a host and a path. Null when the term does not
 * look like a URL at all, so plain words keep the plain substring search.
 */
export function parseSearchUrl(term: string): { host: string; path: string } | null {
  let value = term.trim().replace(/[?#].*$/, "");
  const scp = /^[A-Za-z0-9._-]+@([^:/\s]+):(?!\d+(?:\/|$))(.+)$/.exec(value);
  if (scp !== null) {
    value = `https://${scp[1] ?? ""}/${scp[2] ?? ""}`;
  }
  value = value.replace(/^(?:ssh|git|git\+ssh):\/\//i, "https://");
  // Who it was fetched as does not identify the repo, and a password must
  // never get as far as a parser that would echo it back in an error.
  value = value.replace(/^((?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?)[^/@]*@/, "$1");
  const hadScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
  const parsed = parseImportLine(value)?.parsed;
  if (parsed === undefined) {
    return null;
  }
  // Without a scheme, "nodejs/node" parses as host "nodejs"; only a dotted
  // name (or localhost) is really a host.
  if (!hadScheme && !parsed.host.includes(".") && parsed.host !== "localhost") {
    return null;
  }
  return { host: parsed.host, path: parsed.path };
}

/**
 * The repo list as `viewer` may see it. Visibility is part of the WHERE
 * clause, so the page AND its total only ever count what the viewer can see.
 *
 * - `mine`: the viewer's own repositories, for everyone.
 * - `ownerId`, `ownerRemoved`: the admin only; anyone else asking is refused
 *   rather than silently given a different list.
 * - `gone=true` (the Removed page) needs `view_removed`, and is still limited
 *   to what the viewer can see.
 */
export function listRepos(db: Db, viewer: User, query: RepoListQuery): Page<Repo> {
  if ((query.ownerId !== undefined || query.ownerRemoved !== undefined) && !viewer.isAdmin) {
    throw forbidden("Only the admin can filter repositories by owner.", { requires: "admin" });
  }
  // Sorting by gone_at would order the visible rows by a fact the Removed
  // page keeps behind `view_removed` (which repos are gone, and since when),
  // so it is refused the same way rather than silently ignored.
  if ((query.gone === true || query.sort === "gone_at") && !hasPermission(viewer, "view_removed")) {
    throw forbidden('The Removed page needs the "view_removed" permission.', {
      permission: "view_removed",
    });
  }

  const visible = visibleRepoSqlFilter(viewer, "repos");
  const where: string[] = [visible.sql];
  const params: (string | number)[] = [...visible.params];

  if (query.mine === true) {
    where.push("repos.owner_user_id = ?");
    params.push(viewer.id);
  }
  if (query.ownerId !== undefined) {
    where.push("repos.owner_user_id = ?");
    params.push(query.ownerId);
  }
  if (query.ownerRemoved !== undefined) {
    where.push(
      query.ownerRemoved
        ? "repos.owner_user_id IN (SELECT id FROM users WHERE removed_at IS NOT NULL)"
        : "repos.owner_user_id IN (SELECT id FROM users WHERE removed_at IS NULL)",
    );
  }

  if (query.q !== undefined && query.q.trim() !== "") {
    const pattern = likePattern(query.q.trim());
    const url = parseSearchUrl(query.q);
    if (url === null) {
      where.push(`(repos.path LIKE ? ESCAPE '\\' OR repos.display_name LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern);
    } else {
      // A pasted URL: the repo on that host whose path it names, everything
      // under it when it names an owner (github.com/nodejs), or the repo a
      // deeper page belongs to (github.com/nodejs/node/tree/main). The plain
      // substring match stays so an odd path that happens to parse still hits.
      where.push(
        `(repos.path LIKE ? ESCAPE '\\' OR repos.display_name LIKE ? ESCAPE '\\' OR (
            repos.forge_id IN (SELECT id FROM forges WHERE host = ?)
            AND (
              repos.path = ? COLLATE NOCASE
              OR repos.path LIKE ? ESCAPE '\\'
              OR substr(?, 1, length(repos.path) + 1) = repos.path || '/' COLLATE NOCASE
            )
          ))`,
      );
      const under = `${url.path.replace(/[\\%_]/g, (char) => `\\${char}`)}/%`;
      params.push(pattern, pattern, url.host, url.path, under, url.path);
    }
  }
  if (query.forgeId !== undefined) {
    where.push("repos.forge_id = ?");
    params.push(query.forgeId);
  }
  if (query.state !== undefined) {
    where.push("repos.state = ?");
    params.push(query.state);
  }
  if (query.gone !== undefined) {
    where.push(query.gone ? "repos.gone_at IS NOT NULL" : "repos.gone_at IS NULL");
  }
  if (query.outcome !== undefined) {
    where.push(`${LAST_OUTCOME_SQL} = ?`);
    params.push(query.outcome);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const totalRow = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM repos ${whereSql}`,
    ...params,
  );
  const total = totalRow?.count ?? 0;

  const orderBy = SORT_SQL[query.sort];
  const direction = DIR_SQL[query.dir];
  const offset = (query.page - 1) * query.perPage;

  const rows = db.all<RepoRow & { last_outcome: string | null; last_error_kind: string | null }>(
    `SELECT ${REPO_COLUMNS},
            ${LAST_OUTCOME_SQL} AS last_outcome,
            ${LAST_ERROR_KIND_SQL} AS last_error_kind
       FROM repos ${whereSql}
      ORDER BY ${orderBy} ${direction}, repos.id ${direction}
      LIMIT ? OFFSET ?`,
    ...params,
    query.perPage,
    offset,
  );

  // One batch resolve for the whole page. The listing renders a mode column and
  // a sync-enabled state per row, neither of which is a column on `repos`;
  // resolving them per row would be several queries each.
  const settings = resolveSettingsForRepos(
    db,
    rows.map((row) => row.id),
  );

  const parentIds = forkParentRepoIds(db, rows, viewer);
  const owners = ownersOf(db, rows, viewer);

  const listed = rows.map((row): Repo => {
    const resolved = settings.get(row.id);
    const parentId = parentIds.get(row.id);
    return {
      ...toRepo(row),
      ...ownerDerivedFields(row, viewer),
      ...viewerFields(row, viewer, owners),
      ...(parentId === undefined ? {} : { forkParentRepoId: parentId }),
      cloneMode: resolved?.clone_mode,
      syncEnabled: resolved?.sync_enabled,
      lastOutcome: row.last_outcome === null ? undefined : (row.last_outcome as SyncOutcome),
      lastErrorKind:
        row.last_error_kind === null ? undefined : (row.last_error_kind as SyncErrorKind),
    };
  });

  return { rows: listed, total, page: query.page, perPage: query.perPage };
}

/** Repositories the viewer can see. */
export function countRepos(db: Db, viewer: User): number {
  const visible = visibleRepoSqlFilter(viewer, "repos");
  return (
    db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM repos WHERE ${visible.sql}`,
      ...visible.params,
    )?.count ?? 0
  );
}

/**
 * Repositories currently judged gone upstream, of those the viewer can see.
 * Zero without `view_removed`: the count is the Removed page's headline, and
 * a viewer who may not open that page may not read its size either.
 */
export function countGoneRepos(db: Db, viewer: User): number {
  if (!hasPermission(viewer, "view_removed")) {
    return 0;
  }
  const visible = visibleRepoSqlFilter(viewer, "repos");
  return (
    db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM repos WHERE gone_at IS NOT NULL AND ${visible.sql}`,
      ...visible.params,
    )?.count ?? 0
  );
}

/** COALESCE keeps an empty set from reporting null bytes used. Viewable repos only. */
export function totalDiskUsageBytes(db: Db, viewer: User): number {
  const visible = visibleRepoSqlFilter(viewer, "repos");
  const row = db.get<{ total: number }>(
    `SELECT COALESCE(SUM(disk_usage_bytes), 0) AS total FROM repos WHERE ${visible.sql}`,
    ...visible.params,
  );
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateRepoInput {
  forgeId: number;
  path: string;
  accountOverrideId?: number | null;
  forceAnonymous?: boolean;
  managedByAccountSyncId?: number | null;
  /** New repos sync immediately by default; the importer staggers a bulk run. */
  nextSyncAt?: number | null;
  state?: RepoState;
  /**
   * The user who imported it, and its only owner. Required: the database
   * would quietly fill in the admin for a forgotten one, which would give the
   * repository (and the right to fetch it with the admin's token) to the
   * wrong person.
   */
  ownerUserId: number;
}

/** Retries only guard against an astronomically unlikely short id collision. */
const SHORT_ID_ATTEMPTS = 5;

export function createRepo(db: Db, input: CreateRepoInput): Repo {
  const path = normalizeRepoPath(input.path);
  if (path === "") {
    throw invalid("A repository needs a path.");
  }

  return db.tx(() => {
    requireForge(db, input.forgeId);
    const overrideId = input.accountOverrideId ?? null;
    if (overrideId !== null) {
      assertAccountUsableForRepo(db, overrideId, input.forgeId, input.ownerUserId);
    }

    const now = Date.now();
    const nextSyncAt = input.nextSyncAt === undefined ? now : input.nextSyncAt;

    for (let attempt = 0; attempt < SHORT_ID_ATTEMPTS; attempt += 1) {
      const shortId = generateShortId();
      const slug = buildSlug(path, shortId);
      try {
        const id = db.run(
          `INSERT INTO repos
             (forge_id, path, display_name, slug, short_id, account_override_id,
              force_anonymous, managed_by_account_sync_id, state, next_sync_at,
              consecutive_failures, owner_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          input.forgeId,
          path,
          displayNameFor(path),
          slug,
          shortId,
          overrideId,
          input.forceAnonymous === true ? 1 : 0,
          input.managedByAccountSyncId ?? null,
          input.state ?? "active",
          nextSyncAt,
          input.ownerUserId,
          now,
          now,
        ).lastInsertRowid;
        return requireRepo(db, id);
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // A duplicate forge+path is the caller's problem; a duplicate short id
        // is ours, and retrying with a fresh one resolves it.
        if (findRepoByPath(db, input.forgeId, path) !== undefined) {
          throw conflict(`"${path}" is already backed up from this forge.`, {
            forgeId: input.forgeId,
            path,
          });
        }
      }
    }
    throw conflict("Could not allocate a unique repository id. Please try again.");
  });
}

/**
 * An override account must be the repo OWNER's own account, on the repo's own
 * forge. Someone else's account reads exactly like an account that does not
 * exist: an override is never a way to learn which account ids are real.
 */
function assertAccountUsableForRepo(
  db: Db,
  accountId: number,
  forgeId: number,
  ownerUserId: number | null,
): void {
  const row = db.get<{ forge_id: number; owner_user_id: number }>(
    "SELECT forge_id, owner_user_id FROM accounts WHERE id = ?",
    accountId,
  );
  if (row === undefined || ownerUserId === null || row.owner_user_id !== ownerUserId) {
    throw notFound("Account", accountId);
  }
  if (row.forge_id !== forgeId) {
    throw invalid(
      "That account belongs to a different forge. Credentials are never presented to a host " +
        "they were not registered for.",
      { accountId, accountForgeId: row.forge_id, repoForgeId: forgeId },
    );
  }
}

export interface UpdateRepoOptions {
  /**
   * Who is asking. A path clash with a repository they cannot see is
   * reported without naming it, so a rename is never a way to probe for
   * repositories that exist.
   */
  viewer?: User;
}

/**
 * State, account override, force_anonymous, and path. The forge is never part
 * of the update, and the slug deliberately stays fixed across a path edit so
 * the on-disk backup directory does not have to move.
 */
export function updateRepo(
  db: Db,
  id: number,
  patch: UpdateRepo,
  options: UpdateRepoOptions = {},
): Repo {
  return db.tx(() => {
    const existing = requireRepo(db, id);
    const ownerUserId =
      db.get<{ owner_user_id: number | null }>("SELECT owner_user_id FROM repos WHERE id = ?", id)
        ?.owner_user_id ?? null;
    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (patch.state !== undefined && patch.state !== existing.state) {
      sets.push("state = ?");
      params.push(patch.state);
      if (patch.state === "active" && existing.nextSyncAt === null) {
        sets.push("next_sync_at = ?");
        params.push(Date.now());
      }
    }

    if (patch.accountOverrideId !== undefined) {
      if (patch.accountOverrideId !== null) {
        assertAccountUsableForRepo(db, patch.accountOverrideId, existing.forgeId, ownerUserId);
      }
      sets.push("account_override_id = ?");
      params.push(patch.accountOverrideId);
    }

    if (patch.forceAnonymous !== undefined) {
      sets.push("force_anonymous = ?");
      params.push(patch.forceAnonymous ? 1 : 0);
    }

    if (patch.path !== undefined) {
      const path = normalizeRepoPath(patch.path);
      if (path === "") {
        throw invalid("A repository needs a path.");
      }
      if (path !== existing.path) {
        const clash = db.get<{ owner_user_id: number | null; is_private: number }>(
          "SELECT owner_user_id, is_private FROM repos WHERE forge_id = ? AND path = ?",
          existing.forgeId,
          path,
        );
        if (clash !== undefined) {
          const visible =
            options.viewer === undefined ||
            canView(options.viewer, {
              ownerUserId: clash.owner_user_id,
              isPrivate: clash.is_private !== 0,
            });
          throw conflict(
            visible
              ? `"${path}" is already backed up from this forge.`
              : "This repository cannot be renamed to that path.",
          );
        }
        // The row now names a different upstream of unknown size. An owner
        // already at or over their cap may not point a repo at one at all
        // (otherwise a small synced repo could be renamed to a huge one and
        // skip every cap check, which key on "never synced"); under the cap,
        // the next sync goes back through the first-clone gate.
        const owner = ownerUserId === null ? undefined : getUser(db, ownerUserId);
        if (owner !== undefined && isAtOrOverCap(db, owner)) {
          throw new DomainError(
            "storage_cap_reached",
            "This repository's owner is at or over their storage cap, so it cannot be pointed " +
              "at a different repository until they are under it again.",
          );
        }
        // Nothing is known about its visibility either: back to private
        // until the forge says otherwise.
        sets.push(
          "path = ?",
          "display_name = ?",
          "is_private = 1",
          "visibility_checked_at = NULL",
          "first_clone_gate_path = ?",
        );
        params.push(path, displayNameFor(path), path);
      }
    }

    if (sets.length === 0) {
      return existing;
    }

    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);
    db.run(`UPDATE repos SET ${sets.join(", ")} WHERE id = ?`, ...params);
    return requireRepo(db, id);
  });
}

/** Persisted request for an immediate sync. The scheduler picks this up. */
export function requestSyncNow(db: Db, id: number, at: number = Date.now()): Repo {
  return db.tx(() => {
    requireRepo(db, id);
    db.run("UPDATE repos SET next_sync_at = ?, updated_at = ? WHERE id = ?", at, at, id);
    return requireRepo(db, id);
  });
}

/** Removes the backup directory. Injected so this module does no filesystem IO. */
export type RepoFileRemover = (repo: Repo) => Promise<void>;

export interface DeleteRepoOptions {
  withFiles?: boolean;
  removeFiles?: RepoFileRemover;
}

/**
 * The database row goes first, then the files. A crash between the two leaves
 * an orphan directory, which is recoverable; the other order would leave a row
 * pointing at a backup that no longer exists.
 */
export async function deleteRepo(
  db: Db,
  id: number,
  options: DeleteRepoOptions = {},
): Promise<void> {
  const repo = requireRepo(db, id);
  if (options.withFiles === true && options.removeFiles === undefined) {
    throw invalid("Deleting the backup files needs a file remover.");
  }
  assertSafeSlug(repo.slug);

  db.run("DELETE FROM repos WHERE id = ?", id);

  if (options.withFiles === true && options.removeFiles !== undefined) {
    await options.removeFiles(repo);
  }
}

export interface BulkRepoRefusal {
  id: number;
  error: string;
  message: string;
}

export interface BulkRepoResult {
  action: BulkRepoAction;
  requested: number;
  affected: number;
  /** The ids that were actually acted on. */
  ids: number[];
  /**
   * Ids that do not exist, or that the caller cannot view: the two are
   * reported identically, so a bulk action is never a way to probe.
   */
  missing: number[];
  /** Ids the caller can view but may not act on, with why. Absent when none were. */
  refused?: BulkRepoRefusal[];
}

/**
 * Bulk pause, resume, sync, or delete, with the single-repo rules applied per
 * repo: the owner and the admin always may; anyone else needs modify_others
 * on a repo they can view. Missing and invisible ids are reported rather
 * than failing the whole batch, because a stale multi-select in the UI is
 * normal.
 */
export async function bulkRepoAction(
  db: Db,
  viewer: User,
  ids: readonly number[],
  action: BulkRepoAction,
  options: DeleteRepoOptions = {},
): Promise<BulkRepoResult> {
  const acted: number[] = [];
  const missing: number[] = [];
  const refused: BulkRepoRefusal[] = [];
  const now = Date.now();

  for (const id of ids) {
    const facts = db.get<{ owner_user_id: number | null; is_private: number }>(
      "SELECT owner_user_id, is_private FROM repos WHERE id = ?",
      id,
    );
    const access =
      facts === undefined
        ? undefined
        : { ownerUserId: facts.owner_user_id, isPrivate: facts.is_private !== 0 };
    if (access === undefined || !canView(viewer, access)) {
      missing.push(id);
      continue;
    }
    if (!viewer.isAdmin && !isRepoOwner(viewer, access) && !viewer.permissions.modify_others) {
      refused.push({
        id,
        error: "forbidden",
        message: 'This needs the "modify_others" permission.',
      });
      continue;
    }
    switch (action) {
      case "pause":
        db.run("UPDATE repos SET state = 'paused', updated_at = ? WHERE id = ?", now, id);
        break;
      case "resume":
        db.run(
          `UPDATE repos SET state = 'active',
             next_sync_at = COALESCE(next_sync_at, ?), updated_at = ?
           WHERE id = ?`,
          now,
          now,
          id,
        );
        break;
      case "sync":
        db.run("UPDATE repos SET next_sync_at = ?, updated_at = ? WHERE id = ?", now, now, id);
        break;
      case "delete":
        await deleteRepo(db, id, options);
        break;
    }
    acted.push(id);
  }

  return {
    action,
    requested: ids.length,
    affected: acted.length,
    ids: acted,
    missing,
    // Only present when something was refused, so the answer to a batch that
    // was entirely allowed keeps its original shape.
    ...(refused.length === 0 ? {} : { refused }),
  };
}

// ---------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------

interface SyncRunRow {
  id: number;
  repo_id: number;
  started_at: number;
  finished_at: number | null;
  outcome: string;
  error: string | null;
  error_kind: string | null;
  bytes_fetched: number | null;
  duration_ms: number | null;
  refs_changed: number | null;
  paranoid_archived: number | null;
}

function toSyncRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    repoId: row.repo_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as SyncRun["outcome"],
    error: row.error,
    errorKind: row.error_kind as SyncRun["errorKind"],
    bytesFetched: row.bytes_fetched,
    durationMs: row.duration_ms,
    refsChanged: row.refs_changed,
    paranoidArchived: row.paranoid_archived,
  };
}

export function listSyncRuns(
  db: Db,
  repoId: number,
  query: PaginationQuery,
  viewer?: User,
): Page<SyncRun> {
  requireRepo(db, repoId);
  // Same rule as a repo row's lastError (ownerDerivedFields): run errors came
  // from fetches made with the owner's account.
  const owner =
    db.get<{ owner_user_id: number | null }>("SELECT owner_user_id FROM repos WHERE id = ?", repoId)
      ?.owner_user_id ?? null;
  const redact = viewer !== undefined && !isOwnerOrAdmin(owner, viewer);
  const total =
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM sync_runs WHERE repo_id = ?", repoId)
      ?.count ?? 0;
  const rows = db.all<SyncRunRow>(
    `SELECT id, repo_id, started_at, finished_at, outcome, error, error_kind,
            bytes_fetched, duration_ms, refs_changed, paranoid_archived
     FROM sync_runs WHERE repo_id = ?
     ORDER BY started_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    repoId,
    query.perPage,
    (query.page - 1) * query.perPage,
  );
  const runs = rows
    .map(toSyncRun)
    .map((run) => (redact && run.error !== null ? { ...run, error: OWNER_ONLY_ERROR } : run));
  return { rows: runs, total, page: query.page, perPage: query.perPage };
}
