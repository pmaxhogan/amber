/**
 * Ordered migrations. Never edit one that has shipped; append a new entry.
 * The runner applies each pending migration inside its own transaction.
 */
export interface Migration {
  readonly name: string;
  readonly sql: string;
}

const initial = `
CREATE TABLE forges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol   TEXT    NOT NULL CHECK (protocol IN ('https', 'http')),
  host       TEXT    NOT NULL,
  port       INTEGER NULL CHECK (port IS NULL OR (port >= 1 AND port <= 65535)),
  kind       TEXT    NOT NULL CHECK (kind IN ('github', 'gitlab', 'bitbucket', 'gitea', 'generic')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- port is nullable, so a plain UNIQUE(protocol, host, port) would let duplicate
-- NULL ports through. Two partial indexes cover both cases.
CREATE UNIQUE INDEX idx_forges_identity
  ON forges (protocol, host, port) WHERE port IS NOT NULL;
CREATE UNIQUE INDEX idx_forges_identity_default_port
  ON forges (protocol, host) WHERE port IS NULL;

CREATE TABLE accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  forge_id     INTEGER NOT NULL REFERENCES forges (id) ON DELETE CASCADE,
  username     TEXT    NOT NULL,
  -- AES-256-GCM: 12 byte IV || 16 byte tag || ciphertext.
  secret_enc   BLOB    NULL,
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  last_used_at INTEGER NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (forge_id, username)
);

-- At most one default account per forge. domain/accounts.ts additionally
-- guarantees at least one when the forge has any accounts.
CREATE UNIQUE INDEX idx_accounts_one_default_per_forge
  ON accounts (forge_id) WHERE is_default = 1;

CREATE INDEX idx_accounts_forge ON accounts (forge_id);

CREATE TABLE account_syncs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       INTEGER NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  visibility       TEXT    NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'public', 'private')),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 1),
  next_run_at      INTEGER NULL,
  last_run_at      INTEGER NULL,
  last_error       TEXT    NULL,
  repos_discovered INTEGER NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_account_syncs_due ON account_syncs (next_run_at) WHERE enabled = 1;

CREATE TABLE repos (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  forge_id                    INTEGER NOT NULL REFERENCES forges (id) ON DELETE RESTRICT,
  -- Normalized URL path: no leading slash, no trailing slash or .git.
  path                        TEXT    NOT NULL,
  display_name                TEXT    NOT NULL,
  -- On-disk directory name: sanitized path + '-' + short_id.
  slug                        TEXT    NOT NULL UNIQUE,
  short_id                    TEXT    NOT NULL UNIQUE,
  account_override_id         INTEGER NULL REFERENCES accounts (id) ON DELETE SET NULL,
  force_anonymous             INTEGER NOT NULL DEFAULT 0 CHECK (force_anonymous IN (0, 1)),
  managed_by_account_sync_id  INTEGER NULL REFERENCES account_syncs (id) ON DELETE SET NULL,
  state                       TEXT    NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  next_sync_at                INTEGER NULL,
  consecutive_failures        INTEGER NOT NULL DEFAULT 0,
  last_sync_at                INTEGER NULL,
  last_success_at             INTEGER NULL,
  last_error                  TEXT    NULL,
  disk_usage_bytes            INTEGER NULL,
  default_branch              TEXT    NULL,
  last_fetch_head             TEXT    NULL,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  UNIQUE (forge_id, path)
);

CREATE INDEX idx_repos_due ON repos (next_sync_at) WHERE state = 'active';
CREATE INDEX idx_repos_forge ON repos (forge_id);
CREATE INDEX idx_repos_account_override ON repos (account_override_id);
CREATE INDEX idx_repos_managed_by ON repos (managed_by_account_sync_id);
CREATE INDEX idx_repos_display_name ON repos (display_name);

CREATE TABLE sync_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id          INTEGER NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER NULL,
  outcome          TEXT    NOT NULL CHECK (outcome IN ('success', 'error', 'canceled')),
  error            TEXT    NULL,
  error_kind       TEXT    NULL CHECK (
                     error_kind IS NULL OR error_kind IN (
                       'auth', 'not_found', 'rate_limited', 'network',
                       'timeout', 'disk', 'git', 'other'
                     )
                   ),
  bytes_fetched    INTEGER NULL,
  duration_ms      INTEGER NULL,
  refs_changed     INTEGER NULL,
  paranoid_archived INTEGER NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_sync_runs_repo_started ON sync_runs (repo_id, started_at DESC);
CREATE INDEX idx_sync_runs_outcome ON sync_runs (outcome, started_at DESC);

CREATE TABLE settings (
  scope_type TEXT    NOT NULL CHECK (scope_type IN ('global', 'forge', 'account', 'repo')),
  scope_id   INTEGER NULL,
  key        TEXT    NOT NULL,
  -- JSON encoded value, validated against shared/src/settingsRegistry.ts.
  value      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope_type = 'global') = (scope_id IS NULL))
);

CREATE UNIQUE INDEX idx_settings_identity
  ON settings (scope_type, scope_id, key) WHERE scope_id IS NOT NULL;
CREATE UNIQUE INDEX idx_settings_identity_global
  ON settings (key) WHERE scope_id IS NULL;

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Account syncs gain a `source`: an account can back up the repositories it
 * owns and, separately, the repositories it stars. That turns the old
 * UNIQUE(account_id) into UNIQUE(account_id, source), which SQLite can only
 * express by rebuilding the table.
 *
 * Repos gain an `origin`: only rows an account sync created may ever be removed
 * automatically, so a manually imported repo that a starred sync later links to
 * stays 'manual' and survives an unstar.
 *
 * PRAGMA foreign_keys cannot be toggled inside a transaction and the migration
 * runner wraps every migration in one, so the usual "turn foreign keys off,
 * rebuild, turn them back on" dance is unavailable. The rebuild below is safe
 * without it: dropping the parent table only trips a foreign key check when a
 * child row actually references it, and the rename restores the name before the
 * transaction commits.
 */
const starredSync = `
CREATE TABLE account_syncs_002 (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  source           TEXT    NOT NULL DEFAULT 'owned' CHECK (source IN ('owned', 'starred')),
  -- Applies to source 'owned' only; a starred sync always takes the full list.
  visibility       TEXT    NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'public', 'private')),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 1),
  next_run_at      INTEGER NULL,
  last_run_at      INTEGER NULL,
  last_error       TEXT    NULL,
  repos_discovered INTEGER NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (account_id, source)
);

INSERT INTO account_syncs_002 (
  id, account_id, source, visibility, enabled, interval_minutes,
  next_run_at, last_run_at, last_error, repos_discovered, created_at, updated_at
)
SELECT
  id, account_id, 'owned', visibility, enabled, interval_minutes,
  next_run_at, last_run_at, last_error, repos_discovered, created_at, updated_at
FROM account_syncs;

DROP TABLE account_syncs;

ALTER TABLE account_syncs_002 RENAME TO account_syncs;

CREATE INDEX idx_account_syncs_due ON account_syncs (next_run_at) WHERE enabled = 1;
CREATE INDEX idx_account_syncs_account ON account_syncs (account_id);

ALTER TABLE repos
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
  CHECK (origin IN ('manual', 'account_sync'));

CREATE INDEX idx_repos_origin ON repos (origin);
`;

/**
 * Seed the two big public forges so a fresh install can import from them
 * without any setup. A one-time migration rather than a boot seed on purpose:
 * deleting either one is a normal edit that must stick, and a seed that runs
 * every boot would resurrect them. The guards keep installs that already
 * created a forge on these hosts (any protocol or port) untouched.
 */
const defaultForges = `
INSERT INTO forges (protocol, host, port, kind, created_at, updated_at)
SELECT 'https', 'github.com', NULL, 'github',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM forges WHERE host = 'github.com');

INSERT INTO forges (protocol, host, port, kind, created_at, updated_at)
SELECT 'https', 'gitlab.com', NULL, 'gitlab',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM forges WHERE host = 'gitlab.com');
`;

/**
 * Namespace syncs: back up every repository a named user or organization owns,
 * including ones created later. Such a sync belongs to a forge and only
 * optionally to an account (null = the forge default at run time, or
 * anonymous), so account_syncs gains `forge_id` and `namespace`, `account_id`
 * becomes nullable, and the identity rules move into partial unique indexes:
 * one owned and one starred sync per account, one namespace sync per forge and
 * case-insensitive name. All of that needs a table rebuild again.
 *
 * The rebuild must not lose which repos each sync manages. With foreign keys
 * on, DROP TABLE runs an implicit DELETE that fires repos'
 * ON DELETE SET NULL, and defer_foreign_keys does not stop actions, only
 * checks. So the linkage is snapshotted first and written back after the
 * rename. (002 had no such step, so any links that existed when it ran were
 * cleared then; that is not recoverable from data and the next owned-sync run
 * relinks every repo it lists anyway.)
 */
const namespaceSync = `
CREATE TEMP TABLE account_sync_links_004 AS
  SELECT id, managed_by_account_sync_id AS sync_id
    FROM repos
   WHERE managed_by_account_sync_id IS NOT NULL;

CREATE TABLE account_syncs_004 (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  forge_id         INTEGER NOT NULL REFERENCES forges (id) ON DELETE CASCADE,
  -- NULL only for a namespace sync that runs with the forge default account.
  account_id       INTEGER NULL REFERENCES accounts (id) ON DELETE CASCADE,
  source           TEXT    NOT NULL DEFAULT 'owned'
                     CHECK (source IN ('owned', 'starred', 'namespace')),
  -- The user or organization a namespace sync enumerates.
  namespace        TEXT    NULL,
  -- Applies to 'owned' and 'namespace'; a starred sync always takes the full list.
  visibility       TEXT    NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'public', 'private')),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 1),
  next_run_at      INTEGER NULL,
  last_run_at      INTEGER NULL,
  last_error       TEXT    NULL,
  repos_discovered INTEGER NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((source = 'namespace') = (namespace IS NOT NULL)),
  CHECK (source = 'namespace' OR account_id IS NOT NULL)
);

INSERT INTO account_syncs_004 (
  id, forge_id, account_id, source, namespace, visibility, enabled, interval_minutes,
  next_run_at, last_run_at, last_error, repos_discovered, created_at, updated_at
)
SELECT
  s.id, a.forge_id, s.account_id, s.source, NULL, s.visibility, s.enabled, s.interval_minutes,
  s.next_run_at, s.last_run_at, s.last_error, s.repos_discovered, s.created_at, s.updated_at
FROM account_syncs s
JOIN accounts a ON a.id = s.account_id;

DROP TABLE account_syncs;

ALTER TABLE account_syncs_004 RENAME TO account_syncs;

UPDATE repos
   SET managed_by_account_sync_id = (
         SELECT sync_id FROM account_sync_links_004 l WHERE l.id = repos.id
       )
 WHERE id IN (SELECT id FROM account_sync_links_004)
   AND (SELECT sync_id FROM account_sync_links_004 l WHERE l.id = repos.id)
       IN (SELECT id FROM account_syncs);

DROP TABLE account_sync_links_004;

CREATE UNIQUE INDEX idx_account_syncs_account_source
  ON account_syncs (account_id, source) WHERE source IN ('owned', 'starred');
CREATE UNIQUE INDEX idx_account_syncs_namespace
  ON account_syncs (forge_id, namespace COLLATE NOCASE) WHERE source = 'namespace';
CREATE INDEX idx_account_syncs_due ON account_syncs (next_run_at) WHERE enabled = 1;
CREATE INDEX idx_account_syncs_account ON account_syncs (account_id);
CREATE INDEX idx_account_syncs_forge ON account_syncs (forge_id);
`;

/**
 * 005: `repos.last_seen_at`, the last time a repository was confirmed to exist
 * upstream - a successful fetch, or its appearance in an account-sync listing.
 * Sorting by it surfaces repositories that disappeared upstream. Listing time
 * was never recorded before, so the last successful fetch is the only honest
 * backfill.
 */
const lastSeen = `
ALTER TABLE repos ADD COLUMN last_seen_at INTEGER NULL;
UPDATE repos SET last_seen_at = last_success_at;
`;

/**
 * 006: trending syncs. A fourth source that adds the top_n most-starred
 * repositories created in the last window_days days, daily. A forge may have
 * several, one per window (3 days for what is blowing up right now, 365 for
 * the year's biggest). It belongs to a forge and never to an
 * account (it always runs with the forge default account, or anonymously), so
 * the account_id CHECK widens along with the source CHECK, which means another
 * table rebuild. Same snapshot and restore of repos.managed_by_account_sync_id
 * as 004, for the same reason: DROP TABLE fires that column's ON DELETE SET
 * NULL.
 */
const trendingSync = `
CREATE TEMP TABLE account_sync_links_006 AS
  SELECT id, managed_by_account_sync_id AS sync_id
    FROM repos
   WHERE managed_by_account_sync_id IS NOT NULL;

CREATE TABLE account_syncs_006 (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  forge_id         INTEGER NOT NULL REFERENCES forges (id) ON DELETE CASCADE,
  -- NULL for a trending sync, and for a namespace sync that runs with the
  -- forge default account.
  account_id       INTEGER NULL REFERENCES accounts (id) ON DELETE CASCADE,
  source           TEXT    NOT NULL DEFAULT 'owned'
                     CHECK (source IN ('owned', 'starred', 'namespace', 'trending')),
  -- The user or organization a namespace sync enumerates.
  namespace        TEXT    NULL,
  -- How many repositories a trending sync takes per run.
  top_n            INTEGER NULL CHECK (top_n IS NULL OR top_n BETWEEN 1 AND 100),
  -- How far back a trending sync looks at repository creation dates.
  window_days      INTEGER NULL CHECK (window_days IS NULL OR window_days BETWEEN 1 AND 3650),
  -- Applies to 'owned' and 'namespace' only.
  visibility       TEXT    NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'public', 'private')),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 1),
  next_run_at      INTEGER NULL,
  last_run_at      INTEGER NULL,
  last_error       TEXT    NULL,
  repos_discovered INTEGER NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((source = 'namespace') = (namespace IS NOT NULL)),
  CHECK ((source = 'trending') = (top_n IS NOT NULL)),
  CHECK ((source = 'trending') = (window_days IS NOT NULL)),
  CHECK (source = 'trending' OR source = 'namespace' OR account_id IS NOT NULL),
  CHECK (source <> 'trending' OR account_id IS NULL)
);

INSERT INTO account_syncs_006 (
  id, forge_id, account_id, source, namespace, top_n, window_days, visibility, enabled,
  interval_minutes, next_run_at, last_run_at, last_error, repos_discovered, created_at, updated_at
)
SELECT
  id, forge_id, account_id, source, namespace, NULL, NULL, visibility, enabled, interval_minutes,
  next_run_at, last_run_at, last_error, repos_discovered, created_at, updated_at
FROM account_syncs;

DROP TABLE account_syncs;

ALTER TABLE account_syncs_006 RENAME TO account_syncs;

UPDATE repos
   SET managed_by_account_sync_id = (
         SELECT sync_id FROM account_sync_links_006 l WHERE l.id = repos.id
       )
 WHERE id IN (SELECT id FROM account_sync_links_006)
   AND (SELECT sync_id FROM account_sync_links_006 l WHERE l.id = repos.id)
       IN (SELECT id FROM account_syncs);

DROP TABLE account_sync_links_006;

CREATE UNIQUE INDEX idx_account_syncs_account_source
  ON account_syncs (account_id, source) WHERE source IN ('owned', 'starred');
CREATE UNIQUE INDEX idx_account_syncs_namespace
  ON account_syncs (forge_id, namespace COLLATE NOCASE) WHERE source = 'namespace';
CREATE UNIQUE INDEX idx_account_syncs_trending
  ON account_syncs (forge_id, window_days) WHERE source = 'trending';
CREATE INDEX idx_account_syncs_due ON account_syncs (next_run_at) WHERE enabled = 1;
CREATE INDEX idx_account_syncs_account ON account_syncs (account_id);
CREATE INDEX idx_account_syncs_forge ON account_syncs (forge_id);
`;

/**
 * 007: gone repositories and web push.
 *
 * repos.gone_at is when a repository that had synced at least once was first
 * judged gone upstream (sync/syncRepo.ts decides; a later success clears it).
 * The backfill marks what is already gone at upgrade time, silently: nobody
 * wants a burst of notifications about things that vanished months ago.
 *
 * push_subscriptions holds one row per browser that asked to be notified. The
 * endpoint is a capability URL issued by the browser's push service.
 */
const goneAndPush = `
ALTER TABLE repos ADD COLUMN gone_at INTEGER NULL;

UPDATE repos
   SET gone_at = COALESCE(last_sync_at, updated_at)
 WHERE last_success_at IS NOT NULL
   AND consecutive_failures >= 2
   AND (
     SELECT sr.error_kind FROM sync_runs sr
      WHERE sr.repo_id = repos.id AND sr.finished_at IS NOT NULL
      ORDER BY sr.started_at DESC, sr.id DESC
      LIMIT 1
   ) IN ('not_found', 'auth');

CREATE INDEX idx_repos_gone ON repos (gone_at) WHERE gone_at IS NOT NULL;

CREATE TABLE push_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint        TEXT    NOT NULL UNIQUE,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  user_agent      TEXT    NULL,
  last_success_at INTEGER NULL,
  last_error      TEXT    NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`;

/**
 * 008: where a fork came from.
 *
 * repos.fork_parent is the path, on the same forge, of the repository this one
 * was forked from. It only means something once fork_known is 1: then NULL is
 * "not a fork". While fork_known is 0 nobody has an answer yet: a manual
 * import says nothing about forks, and GitHub's listings carry only a boolean,
 * so the parent takes one more API call per fork (providers/forks.ts drips
 * those out in the background).
 *
 * fork_checked_at is the last time the forge was asked, whatever it said. A
 * repository the forge will not show us right now (taken down, hidden, rate
 * limited) stays unknown and is asked again later rather than being written
 * down as "not a fork".
 */
const forkParent = `
ALTER TABLE repos ADD COLUMN fork_parent TEXT NULL;
ALTER TABLE repos ADD COLUMN fork_known INTEGER NOT NULL DEFAULT 0 CHECK (fork_known IN (0, 1));
ALTER TABLE repos ADD COLUMN fork_checked_at INTEGER NULL;

CREATE INDEX idx_repos_fork_unknown ON repos (fork_checked_at) WHERE fork_known = 0;
`;

/**
 * 009: is the owner gone too.
 *
 * When a repository goes gone, the reason is either that one repository was
 * removed or that the whole account (user or organization) was deleted or
 * suspended, which takes everything it owned along. owner_gone records what
 * the forge said about the owner: 1 = the owner 404s as well, 0 = the owner is
 * still there, NULL = nobody has asked. It only means something while gone_at
 * is set. owner_checked_at is the last time the forge was asked, whatever it
 * said, so an owner that comes back (accounts get hidden and restored) is
 * picked up again.
 */
const ownerGone = `
ALTER TABLE repos ADD COLUMN owner_gone INTEGER NULL CHECK (owner_gone IN (0, 1));
ALTER TABLE repos ADD COLUMN owner_checked_at INTEGER NULL;
`;

export const migrations: readonly Migration[] = [
  { name: "001_initial", sql: initial },
  { name: "002_starred_sync", sql: starredSync },
  { name: "003_default_forges", sql: defaultForges },
  { name: "004_namespace_sync", sql: namespaceSync },
  { name: "005_last_seen", sql: lastSeen },
  { name: "006_trending_sync", sql: trendingSync },
  { name: "007_gone_and_push", sql: goneAndPush },
  { name: "008_fork_parent", sql: forkParent },
  { name: "009_owner_gone", sql: ownerGone },
];
