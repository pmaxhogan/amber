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

export const migrations: readonly Migration[] = [{ name: "001_initial", sql: initial }];
