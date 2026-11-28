# Amber Architecture

Amber is a self-hosted git backup service. It keeps up-to-date local backups of git
repositories from any HTTPS remote, on a schedule, with optional never-lose-history
paranoid mode, and can serve its backups back out as a read-only git remote.

Tagline: "Amber - git history, preserved."

This document is the source of truth for module boundaries, data model, API surface,
and security rules. Builder agents implement against this doc. Deviations require a
note in the PR/commit message and a doc update.

## Locked stack

- Node.js: engines `>=24`, dev + Docker runtime on Node 26 (`.node-version` = 26).
- TypeScript everywhere, ESM only (`"type": "module"`). Try latest TS (7.x); if
  vue-tsc / typescript-eslint / vitest are incompatible with TS7, fall back to the
  latest 5.x and leave a comment in package.json.
- npm workspaces monorepo: `shared/`, `server/`, `web/`, `e2e/`.
- Server: Fastify 5. Frontend: Vue 3 + Vite 8 SPA + PrimeVue 4 (+ @primeuix/themes 2),
  pinia, vue-router. Validation: zod 4 in `shared/`, inferred types on both sides.
  PrimeVue is pinned to the 4.x MIT line: 5.x adopted the commercial PrimeUI license
  model, where every deployment - including the free Community tier - needs a
  registered key and shows an "Invalid PrimeUI License" banner without one. Amber is
  a public clone-and-deploy project, so there is no key to ship. `@primeuix/themes`
  tracks that at 2.x, and `.github/dependabot.yml` ignores both majors. Revisit only
  if PrimeVue relicenses.
- DB: built-in `node:sqlite`. No ORM. Hand-rolled typed data layer + migration runner.
- Logging: pino 10 only. Never console.*. stdout (NDJSON) + pino-roll size-rotated
  files in `$LOGS_DIR`. Child loggers per module (`log.child({ mod: "sync" })`).
- Git operations: system `git` + `git-lfs` binaries via a hardened spawn wrapper.
- Lint/format: ESLint 10 flat config + typescript-eslint + eslint-plugin-vue;
  Prettier (semicolons, double quotes, 2-space). ASCII only: NO em/en dashes in any
  file, ever - use `-`.
- Tests: Vitest 4 (v8 coverage). Playwright for one docker smoke e2e.
- License MIT. Public repo. NEVER commit secrets; `.env` files are gitignored.

## Directory layout (repo)

```
package.json              # workspaces root, scripts fan out via npm -w
tsconfig.base.json
eslint.config.js
.prettierrc.json
.node-version             # 26
.github/workflows/ci.yml
.github/workflows/build-image.yml
.github/workflows/dependabot-automerge.yml
.github/dependabot.yml
docs/ARCHITECTURE.md      # this file
shared/src/               # zod schemas, API types, settings registry, url parser types
server/src/
  index.ts                # entrypoint: config -> logger -> db -> app.listen
  app.ts                  # buildApp(deps): registers plugins/routes; exported for tests
  config.ts               # env parsing/validation (zod), fail-fast
  logging.ts              # pino setup (stdout + pino-roll multistream)
  db/db.ts                # node:sqlite wrapper (open, pragmas, tx helper, typed query helpers)
  db/migrate.ts           # migration runner
  db/migrations.ts        # ordered array of {name, up(sql)} migrations (SQL strings)
  security/cfAccess.ts    # CF Access JWT middleware
  security/identity.ts    # who is asking: ends every accepted request with request.user
  security/accessPolicy.ts # reads the Access policy (CF API), the membership rule
  security/authz.ts       # canView, per-route config.authz, requireRepo* helpers
  security/audience.ts    # who may be told about a repo (push, events)
  security/eventAudience.ts # per-event SSE filter, decided at send time
  security/egress.ts      # restricted-forge egress guard: public-only, pinned addresses
  security/secrets.ts     # AES-256-GCM encrypt/decrypt for account credentials
  security/gitPassword.ts # scrypt hash/verify + generator for git remote passwords
  domain/users.ts         # users, permissions merge, adopt, usage and caps
  domain/caps.ts          # storage cap transitions and first-clone gates
  domain/credentials.ts   # THE rule for which account a repo or sync fetches with
  domain/errors.ts        # DomainError codes -> HTTP statuses
  domain/forges.ts        # forge CRUD + kind detection + restricted-forge vetting
  domain/accounts.ts      # account CRUD + per-owner default-account invariants
  domain/repos.ts         # repo CRUD + listing query builder (paginate/sort/filter)
  domain/settings.ts      # layered settings resolution
  domain/importer.ts      # URL parsing + bulk import (host vetting, caps, ownership)
  sync/gitCli.ts          # hardened git spawn wrapper (askpass, allowlisted flags)
  sync/syncRepo.ts        # single-repo sync: modes, paranoid archival, LFS
  sync/gone.ts            # the rule for "this repository is gone upstream"
  sync/scheduler.ts       # queue, worker pool, stagger, backoff, breaker, startup catch-up
  sync/diskUsage.ts       # du of repo dirs (cached in DB per sync)
  providers/types.ts      # AccountSyncProvider interface (listRepos, listStarred?,
                          #   listNamespaceRepos?, listTrending?, checkRepoAccess?)
  providers/github.ts     # + gitlab.ts, bitbucket.ts, gitea.ts
  providers/discovery.ts  # account-sync run: enumerate -> upsert repos
  providers/forks.ts      # background resolver: which repository a fork came from
  providers/owners.ts     # background resolver: is a gone repository's owner gone too
  gitremote/routes.ts     # smart HTTP read-only remote (/git/*)
  gitremote/auth.ts       # /git authentication: kill switch, throttle, credential, membership
  gitremote/credentials.ts # per-user username slug + password minting
  gitremote/config.ts     # the kill switch (kv git_remote.enabled)
  gitremote/throttle.ts   # per-IP failure throttle
  web.ts                  # serves the built SPA + client-route fallback
  notify/push.ts          # web push: VAPID keys, subscriptions, gone notifications
  export/archive.ts       # zip/tar.gz/7z streaming of source, git-archive, file listing
  browse/*.ts             # read-only repository browser: refs, contents, raw, history, diffs
  routes/*.ts             # REST routes per resource (thin; call domain/*): repos,
                          #   imports, forges, accounts, accountSyncs, settings, me, users,
                          #   gitRemoteConfig (the caller's own credential + kill switch),
                          #   push, status, events, browse, exports
  events.ts               # SSE broadcaster for live UI updates
web/src/
  main.ts, App.vue, router/ (route guards read the me store), stores/ (me, status,
  events, theme), pages/ (Repos, Import, Accounts, AccountSync, Settings, GitRemote,
  Users, Removed, About), components/ (CapBanner, AccessScreen, ...), lib/ownership.ts, theme/
  components/browse/      # the Browse tab of the repo drawer
  lib/markdown/           # hostile markdown -> sanitized, sandboxed frame document
  theme/amber-preset.ts   # PrimeVue theme preset, dark-first amber palette
  assets/logo.svg         # inclusion-in-amber mark
e2e/                      # playwright: smoke, browse, hostile, hygiene, multiuser (three
                          #   identities) against the built server; a docker image check
Dockerfile
docker-compose.local.yml  # local full-stack test (docker desktop)
deploy/docker-compose.nas.yml
deploy/README.md          # NAS + Cloudflare runbook
scripts/coverage-ratchet.mjs
coverage-baseline.json
```

## Data model (SQLite)

DB file: `$STATE_DIR/amber.db`. Pragmas on open: `journal_mode=WAL`,
`synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`. Single process,
single writer. All multi-statement writes inside transactions via a `tx()` helper.

Migrations: `db/migrations.ts` exports an ordered list `{ name, sql }` (or
`up(db)` functions). Runner records applied names in a `migrations` table inside
a transaction per migration. Never edit an applied migration; append new ones.

Tables (columns abridged; all tables get `created_at`, `updated_at` ints, epoch ms):

- `forges`: `id` PK, `protocol` ('https'|'http'), `host` TEXT, `port` INTEGER NULL,
  `kind` ('github'|'gitlab'|'bitbucket'|'gitea'|'generic'), UNIQUE(protocol, host, port),
  `allow_private_network` INTEGER 0/1 (migration 010; see "Forges and outbound requests").
  Kind auto-detected from host on create (github.com -> github, gitlab.com -> gitlab,
  bitbucket.org -> bitbucket), user-editable (self-hosted gitea/gitlab).
- `accounts`: `id` PK, `forge_id` FK CASCADE, `username` TEXT,
  `secret_enc` BLOB NULL (AES-256-GCM: 12b IV || 16b tag || ciphertext),
  `is_default` INTEGER 0/1, `last_used_at`. UNIQUE(forge_id, username).
  `owner_user_id` FK users (migration 010; an account belongs to exactly one user).
  Partial unique index: `ON accounts(owner_user_id, forge_id) WHERE is_default = 1`.
  Invariant (enforced in domain/accounts.ts, tested): per OWNER and forge, a user with
  >=1 accounts there has exactly one default. Deleting the default promotes that owner's
  oldest remaining account on the forge. UNIQUE(forge_id, username) stays global: one
  forge login is registered by one Amber user.
- `repos`: `id` PK, `forge_id` FK RESTRICT, `path` TEXT (normalized URL path, no
  leading slash, no trailing `.git` or `/`; e.g. `nodejs/node` or
  `pub/scm/linux/kernel/git/torvalds/linux`), `display_name` TEXT (last path segment),
  `slug` TEXT UNIQUE (disk dir name: sanitized path + `-` + short_id),
  `short_id` TEXT UNIQUE (8 chars base36, crypto random),
  `account_override_id` FK NULL SET NULL, `force_anonymous` INTEGER 0/1,
  `managed_by_account_sync_id` FK NULL SET NULL,
  `state` ('active'|'paused'), `next_sync_at` INTEGER NULL,
  `consecutive_failures` INTEGER, `last_sync_at`, `last_success_at`,
  `last_error` TEXT NULL, `disk_usage_bytes` INTEGER NULL,
  `default_branch` TEXT NULL, `last_fetch_head` TEXT NULL,
  `last_seen_at` INTEGER NULL (last time the repo was confirmed to exist
  upstream: set by every successful fetch and by every account-sync listing
  that contains it, whichever sync manages the row; never set by a failure.
  The listing sorts by it so a repo that disappeared upstream stands out.
  Migration 005 backfilled it from `last_success_at`).
  `gone_at` INTEGER NULL (when a repository that had synced at least once was
  judged gone upstream; see "Gone repositories" under Sync engine. Migration
  007 backfilled it, silently, for repositories already gone at upgrade time).
  `fork_parent` TEXT NULL, `fork_known` INTEGER 0/1, `fork_checked_at` INTEGER
  NULL (migration 008; see "Fork parents" under Sync engine). `fork_parent` is
  the path, on the same forge, of the repository this one was forked from. It
  only means something once `fork_known` is 1: then NULL is "not a fork".
  `fork_checked_at` is the last time the forge was asked, whatever it said.
  `owner_gone` INTEGER NULL (0/1), `owner_checked_at` INTEGER NULL (migration
  009; see "Gone owners" under Sync engine). Whether the account that owned a
  gone repository is gone as well. NULL until the forge has answered, and
  only meaningful while `gone_at` is set.
  `owner_user_id` FK users RESTRICT, `is_private` INTEGER 0/1 (default 1: unknown is
  private), `visibility_checked_at` INTEGER NULL (migration 010; see "Multi-user access
  control").
  UNIQUE(forge_id, path). Re-importing an existing forge+path changes NOTHING (not the
  owner, not the account override, not the schedule): it answers "Already backed up" to
  a user who can view the repo and "Amber could not import this repository" to one who
  cannot (idempotent import).
- `sync_runs`: `id` PK, `repo_id` FK CASCADE, `started_at`, `finished_at`,
  `outcome` ('success'|'error'|'canceled'), `error` TEXT NULL, `error_kind` TEXT NULL
  ('auth'|'not_found'|'rate_limited'|'network'|'timeout'|'disk'|'git'|'other'),
  `bytes_fetched` INTEGER NULL, `duration_ms`, `refs_changed` INTEGER NULL,
  `paranoid_archived` INTEGER NULL. Retention (enforced after each run): keep newest
  50 per repo; error rows additionally kept 30 days regardless of count.
- `settings`: `scope_type` ('global'|'forge'|'account'|'repo'), `scope_id` INTEGER
  NULL (NULL for global), `key` TEXT, `value` TEXT (JSON). UNIQUE(scope_type,
  scope_id, key).
- `account_syncs`: `id` PK, `forge_id` FK CASCADE, `account_id` FK CASCADE
  NULL, `source` ('owned'|'starred'|'namespace'|'trending', default 'owned'),
  `owner_user_id` FK users (migration 010), `namespace` TEXT NULL, `top_n` INTEGER NULL (1..100), `window_days` INTEGER
  NULL (1..3650), `visibility` ('all'|'public'|'private', applies to owned and
  namespace syncs), `enabled` 0/1, `interval_minutes` (default 360),
  `next_run_at`, `last_run_at`, `last_error` TEXT NULL, `repos_discovered` INTEGER.
  CHECKs: `namespace` is set exactly when source='namespace'; `top_n` and
  `window_days` are set exactly when source='trending'; only a namespace or
  trending sync may have a NULL `account_id`, and a trending sync always does.
  Partial unique indexes: one owned and one starred sync per owner and account
  (`(owner_user_id, account_id, source) WHERE source IN ('owned','starred')`), one
  namespace sync per owner, forge and name (`(owner_user_id, forge_id, namespace COLLATE
  NOCASE) WHERE source = 'namespace'`), and one trending sync per forge and window
  (`(forge_id, window_days) WHERE source = 'trending'`: trending is instance-level, so
  this one stays per forge).
  Trending sync semantics (GitHub kind only for now; error clearly elsewhere):
  - Auto-discovery of repositories that are valuable and likely to be taken
    down. Each run asks the forge for the `top_n` most-starred repositories
    created in the last `window_days` days and imports the ones amber does not
    have. GitHub: one request, `GET /search/repositories?q=created:>=DATE
    &sort=stars&order=desc&per_page=N` - the same query the
    github-trending-daily project runs. `top_n` is capped at 100 so a run is
    always a single search page (the search API allows 10 requests a minute
    anonymously).
  - `window_days` is the identity next to the forge, so several can coexist: 3
    days (the default) for what is blowing up right now, 365 for the year's
    biggest. It is immutable; `top_n` is editable. The interval defaults to
    1440 minutes instead of 360.
  - It belongs to the forge and has no pinned account. Creating one needs
    `manage_settings`, the creator becomes its `owner_user_id`, and every run uses
    the OWNER's default account on that forge (read fresh each run), anonymous when
    the owner has none or may not use accounts (a non-admin needs `import_private`;
    the admin always may). Everything it adds is owned by that user. Trending syncs
    are listed to every user (`GET /api/account-syncs`), but only a user with
    `manage_settings` (the admin always) may change one. Search only returns public repositories, so visibility
    does not apply.
  - It NEVER removes anything, and a repository that drops off the list is not
    counted as vanished or logged: falling off is what trending lists do
    daily. Whatever trended once keeps its backup and keeps syncing.
  - A failed run of any source is retried after at most 60 minutes rather
    than a full interval, so a rate-limited daily run does not skip its day.
  - Migration 006 rebuilds the table again, with the same snapshot and restore
    of `repos.managed_by_account_sync_id` as 004.
  Namespace sync semantics (GitHub kind only for now; error clearly elsewhere):
  - Backs up every repository a NAMED user or organization owns, whoever that
    is - not the account's own repos. GitHub: `GET /users/{name}` decides user
    vs organization; organizations list via `/orgs/{org}/repos?type=all`, users
    via `/user/repos` when the token is theirs and `/users/{name}/repos`
    otherwise.
  - Every run re-enumerates, so repositories created after the sync was set up
    are imported on the next run. Like owned syncs it NEVER auto-removes: a
    repository deleted or transferred upstream keeps its backup.
  - It belongs to a forge, and the account is optional. NULL `account_id`
    means "the sync OWNER's default account on that forge at run time,
    anonymous if there is none". A pinned account must be the owner's own, and
    also becomes the account override of the repos the sync creates, so private
    repos it found are fetched with the same token.
  - Deleting a pinned account sets the sync's `account_id` to NULL (done in
    domain/accounts.ts before the delete) rather than cascading, so a whole
    organization's backups never stop silently.
  - Migration 004 rebuilds the table and has to snapshot and restore
    `repos.managed_by_account_sync_id`: with foreign keys on, `DROP TABLE` runs
    an implicit DELETE that fires that column's ON DELETE SET NULL. Migration
    002 did a rebuild without that step, so links that existed then were
    cleared; the next owned-sync run relinks every repo it lists.
  Starred sync semantics (GitHub kind only for now; error clearly on other kinds):
  - Every run re-enumerates the CURRENT starred list (it changes over time);
    new starred repos are created like any discovery (origin recorded).
  - Repos get an `origin` column ('manual'|'account_sync'): only repos CREATED by
    an account sync are ever eligible for auto-removal; manually imported repos
    that later got linked are never auto-removed.
  - Auto-removal rule (starred syncs only; owned syncs never auto-remove):
    a repo created by this starred sync that is absent from the fresh starred
    list is removed (row + backup files, loudly logged) ONLY IF amber first
    confirms the repo still exists and is accessible upstream (e.g. GitHub
    GET /repos/{owner}/{repo} returns 200 with the same token context).
    Any 404/403/5xx/network failure on that check means KEEP the repo and keep
    syncing it - a repo that vanished or errors upstream is exactly what a
    backup must retain; only a confirmed intentional unstar frees disk.
- `push_subscriptions`: `id` PK, `endpoint` TEXT UNIQUE (the capability URL a
  browser's push service issued), `p256dh`, `auth`, `user_agent` TEXT NULL,
  `user_id` FK users (migration 010), `last_success_at`, `last_error` TEXT NULL.
  One row per browser that asked to be notified, owned by whoever subscribed it last.
- `users` (migration 010): one row per identity Amber has admitted; exactly one is
  the admin. Columns and the full multi-user model are under "Multi-user access
  control". Rows are never deleted.
- `kv`: `key` TEXT PK, `value` TEXT. Uses: the git remote kill switch
  (`git_remote.enabled`; credentials are per user, on the `users` row), the cached
  access policy (`access_policy.emails`, `access_policy.fetched_at`), the web push
  VAPID key pair, instance id, cached JWKS, schema/state misc.

Every `owner_user_id` / `user_id` column added by migration 010 is nullable only
because SQLite cannot add NOT NULL with a foreign key default; BEFORE INSERT and
BEFORE UPDATE triggers make each one NOT NULL in effect (an insert or update that
leaves the owner NULL aborts, and nothing is silently handed to the admin).

## Layered settings

Registry lives in `shared/src/settingsRegistry.ts`: each key declares zod schema,
default, allowed scopes, and UI metadata (label, description, group). Keys:

| key                        | default | scopes    |
| -------------------------- | ------- | --------- |
| `clone_mode` ('bare' \| 'full' \| 'shallow' \| 'mirror') | `bare` | all |
| `shallow_depth` (int >=1)  | 1       | all       |
| `shallow_refs` ('all' \| 'default_branch') | `all` | all |
| `sync_interval_minutes`    | 180     | all       |
| `sync_enabled` (bool)      | true    | all       |
| `lfs_enabled` (bool)       | true    | all       |
| `paranoid` (bool)          | false   | all       |
| `max_concurrent_syncs`     | 8       | global    |
| `max_concurrent_per_forge` | 4       | global    |
| `default_user_storage_cap_gb` | 5    | global    |
| `min_free_disk_gb`            | 5    | global    |

Resolution order (narrowest wins): repo -> effective account (the account the repo's
fetches would use, by the credential rule in "Credentials are per user": the OWNER's
override or default account; skipped when force_anonymous or no account) -> forge ->
global -> registry default. `domain/settings.ts` exposes
`resolveSettings(repoId)` returning the fully-merged typed object plus, for the UI,
`explainSettings(repoId)` that reports which scope supplied each value, and
`resolveSettingsForRepos(ids)` which answers for a whole page of repos in a fixed
handful of queries (one per scope) rather than repeating the per-repo path.

Read and write semantics, which the UI depends on:

- `GET /api/settings/:scopeType/:scopeId?` returns the overrides STORED AT that
  scope, sparse - never the resolved set. The distinction is load-bearing: the
  settings editor has to tell "set here, to a value that happens to equal the
  default" apart from "inherited", and resolved values make those identical.
- `PUT` takes the same shape, where a **null value CLEARS** the override at that
  scope and lets resolution fall through to the next layer. Clearing a key that
  was never set is a no-op, not an error.
- Both answer with `{ scopeType, scopeId, values }`. Unknown keys, and keys not
  storable at the scope, are rejected as a whole rather than silently dropped, so
  a typo cannot look like it saved.

## Import parsing (shared/src/importUrl.ts, used by server + web preview)

Accepted line formats (one per line, blank lines and `#` comments ignored):

- Full URLs: `https://github.com/nodejs/node`, `http://host:8080/x/y.git`
- Proto-less: `github.com/nodejs/node/` (assume https, default port)
- User prefix: `pmaxhogan@github.com/pmaxhogan/mkvid` or
  `https://b@github.com/d/e` - the user part selects among the IMPORTER'S OWN accounts
  on that forge (never another user's): if the importer has an account with that
  username it becomes the new repo's override; otherwise import succeeds with a warning
  and no override (do not create accounts implicitly). A user without `import_private`
  imports anonymously and the line says so. The prefix only matters when the repo is
  created: re-importing an existing repo changes nothing.
- Trailing `.git` optional and stripped for identity; `path` is the normalized key.
- Whole namespaces: a single path segment on a forge whose kind supports
  namespace sync (`https://github.com/nodejs`, `me@github.com/acme`) imports as
  a namespace sync instead of a repo. The kind comes from the stored forge, or
  from host detection when the import would create the forge; on every other
  kind a single segment stays a repository (`host/repo` is common on plain git
  servers). The parser stays pure and cannot know the kind, so the server tags
  each result `target: 'repo' | 'namespace'` on preview and commit. Re-import is
  idempotent per importer, forge and namespace (case-insensitive): another
  user's sync of the same namespace is theirs and is never touched; a `user@`
  prefix pins one of the importer's own accounts (never creates one) and a
  prefix-less line never unpins it. A namespace line, like a repo line, needs
  `import`; a new host needs `manage_forges` or the admin.
  Namespace lines do not count toward the first-sync stagger, and a committed
  one answers with `accountSyncId` instead of `repoId`.

Rejected: `ssh://`, `git@host:path` (scp syntax), `git://` - error clearly per line
("SSH remotes are not supported yet"). Parser returns per-line results
(ok/warning/error) so the UI can show a preview table before committing.

Non-collision guarantees (tested): same path on different forges = distinct repos;
different paths on one forge = distinct; the disk slug always carries short_id so
directory names never collide regardless of sanitization overlaps.

## Sync engine

- Persistent schedule: each repo row carries `next_sync_at`. On boot the scheduler
  loads active repos; anything overdue is queued exactly once (natural dedup: one
  repo = one row = one queue entry; a 2-day outage means one catch-up fetch).
  New repos: `next_sync_at = now` (immediate first clone), thereafter
  `last attempt + interval + jitter(+-10%)`. Initial import of N repos staggers
  first syncs across a few minutes to avoid a thundering herd.
- Queue: in-memory min-heap by `next_sync_at`, refreshed from DB on wake; worker
  pool of `max_concurrent_syncs` (8), per-forge cap `max_concurrent_per_forge` (4).
  Manual "sync now" jumps the queue.
- Failure handling: exponential backoff with full jitter:
  `delay = min(interval, 60s * 2^consecutive_failures) * rand(0.5..1.5)`, persisted
  via `next_sync_at`, so restarts keep backoff state. `error_kind` classified from
  git stderr/HTTP codes. 404/401/403 do NOT disable the repo (the forge may be down;
  that is the point of a backup) - they just keep backing off to at most the normal
  interval. Rate limiting (HTTP 429 or provider-specific messages): back off harder
  (respect Retry-After when the provider API surfaces it in account-sync; for git
  fetch treat as `rate_limited` and use 2x backoff).
- Network loss: circuit breaker - if the last 5 sync attempts across DIFFERENT
  forges all failed with `network`/`timeout`, pause dequeuing for 60s and probe with
  a single retry; repeat with capped growth (max 10 min). Never tight-loops, never
  gives up permanently.
- Modes:
  - `bare` (default): bare repo; fetch refspecs `+refs/heads/*:refs/heads/*`
    `+refs/tags/*:refs/tags/*`; `--prune` ONLY when paranoid=false.
  - `mirror`: bare with `+refs/*:refs/*` (everything incl. notes, Pull/MR refs when
    the server advertises them), `--prune` only when paranoid=false.
  - `shallow`: bare + `--depth <shallow_depth>`. Depth bounds history, not
    breadth: every branch and tag tip still costs one full tree. With
    `shallow_refs=default_branch` the fetch names only
    `+refs/heads/<default>:refs/heads/<default>` and passes `--no-tags`, which is
    what keeps a repository with thousands of branches small. The default branch
    is the one the origin advertises, else the one the last good sync recorded;
    with neither the run fails instead of widening to every ref. Refs an existing
    backup already holds outside that branch are left alone (nothing garbage
    collects), so shrinking one means cloning it again.
  - `full`: working tree; fetch like bare, then hard-update the default branch
    checkout with hooks and smudge disabled, then explicit `git lfs checkout`.
- Paranoid mode (per-scope setting):
  - Repo-level git config set once: `gc.auto=0`, `gc.pruneExpire=never`,
    `gc.reflogExpireUnreachable=never`, `gc.reflogExpire=never`,
    `core.logAllRefUpdates=always`, `fetch.prune=false`.
  - Sync flow: snapshot all local ref tips (for-each-ref) -> fetch with force
    refspecs, NO prune -> for every ref whose old tip is not an ancestor of its new
    tip (or which vanished upstream while we still have it), write an archive ref
    `refs/amber/archive/<utc yyyymmddThhmmssZ>/<original ref path>` pointing at the
    old tip BEFORE the update lands (archive-then-update ordering; on crash the
    archive ref exists even if the update was applied - reflog covers the gap).
  - LFS in paranoid: `git lfs fetch --all` (all objects for all reachable refs incl.
    archives); LFS objects are never pruned.
  - Never run `git gc`/`prune`/`repack -d` on paranoid repos except `gc --no-prune`.
  - ACCEPTED DEVIATION - there is no upstream-deletion DETECTION step. Amber
    never asks the forge "was this branch deleted on purpose". What preserves
    history is that the local refs are simply never pruned: `--prune` is off,
    the archive refs pin every tip that stopped being reachable, and the
    reflog and gc settings keep the objects alive. A ref that vanishes upstream
    is therefore retained by construction rather than by a decision, which is
    the safer failure mode - a forge outage looks exactly like a deletion, and
    both outcomes are "keep everything".
  - The torture test suite is the acceptance gate (see Testing).
- HEAD in the backup is pointed at the upstream default branch after every
  fetch, in EVERY mode - not just `full`. A bare backup whose HEAD still names
  git's init default advertises a symref that resolves to nothing, so a clone
  off the read-only remote succeeds and checks out an empty tree. HEAD follows
  the upstream across a rename, and a repo whose default branch was not
  advertised keeps whatever HEAD it has rather than failing the sync.
- No fetch refspec is written into the repo's git config. Every fetch passes its
  refspecs explicitly on the command line, which is what keeps a mode change
  (bare to mirror, say) from being silently overridden by config left behind by
  the previous mode.
- Which forges get LFS at all is an egress decision (see "Forges and outbound
  requests"): unrestricted and well-known public forges run git-lfs, ALWAYS
  with the endpoint forced on the command line,
  `-c lfs.url=<remote>.git/info/lfs`, so a repository's `.lfsconfig` (or a
  `remote.<name>.lfsurl`) cannot point git-lfs, and the owner's credential,
  at another host, the LAN included (command-line config outranks
  `.lfsconfig`, and `lfs.url` outranks the per-remote key, git-lfs-config(5));
  every other restricted forge skips git-lfs entirely, whatever `lfs_enabled`
  says.
- LFS fetch failures are non-fatal: they are logged at warn and the sync still
  records success. An LFS server that is down, rate limiting, or refusing a
  token must not cost the run its git objects, which are the part that matters.
- Gone repositories (`sync/gone.ts` owns the rule, `judgeGone`): a repository
  is GONE when it has synced successfully at least once and its fetches have
  then failed with `not_found` or `auth` for `GONE_CONFIRM_MS` (6 hours) on
  end, at least `GONE_AFTER_FAILURES` (2) of them. Both kinds count because a
  deleted, taken down or newly private repository answers an anonymous fetch
  with a credential prompt (`auth`) and a token-bearing one with "not found".
  The window is measured from the first failure of the current unbroken run of
  those two kinds (read from `sync_runs`), so a success or a different kind of
  failure starts it over. It is a span of time, not a count, because the retry
  after a first failure comes a minute or two later: the original rule (two in
  a row) flagged anything unreachable for two minutes, and forges hide public
  repositories for hours and then bring them back (measured on GitHub,
  2026-11: 1.2h and 2.2h). The one exception is a GitHub DMCA takedown
  (`dmcaTakedown` in shared, matched on what git printed and gated on the
  forge kind): the forge has said outright that the repository was removed, so
  the first such answer is enough. The failing run sets `repos.gone_at` (never
  overwritten by later failures), publishes `repo.gone` once with a `reason`
  (`dmca_takedown`, `not_found` or `auth`), and logs at warn. Nothing else
  changes: the backup stays and the repo keeps syncing, so the next success
  clears `gone_at` and it can go gone, and notify, again later. For a week
  after going gone its backoff is capped at one hour instead of its sync
  interval (`goneRecheckCapMs`), so a repository that comes back leaves the
  Removed page within the hour. A repository that never synced is never gone;
  it is a typo. Why it is gone is not stored: the Removed page derives it from
  `last_error` and the newest run's kind, so it always says what the forge
  says now.
- Fork parents (`providers/forks.ts`, `resolvePendingForks`): the Repos page
  shows what each fork was forked from. A listing proves what it can for free
  (GitHub and Gitea listings say whether a repository is a fork, Gitea's also
  says of what; GitLab's and Bitbucket's say neither), and discovery writes
  that down, never replacing a known answer with an unknown one. Everything
  else - every manual import, and every GitHub fork, whose parent is only on
  `GET /repos/{owner}/{repo}` - is asked for in the background: on the
  account-sync tick, 20 repositories with `fork_known = 0` at a time,
  never-asked first, one single-repository GET each, with the credential the
  repository's own fetches would use and never an account of another forge.
  A definite answer sets `fork_known`; a 404, 403, 5xx or network failure only
  stamps `fork_checked_at`, so a repository the forge will not show right now
  (taken down, hidden) is asked again a day later rather than being recorded
  as "not a fork". A rate limit stops that forge for an hour. Generic forges
  have no provider and stay unknown. Known gap: on GitLab and Bitbucket a fork
  whose upstream is private or deleted reads as "not a fork", because the
  forge's answer cannot tell the two apart.
- Gone owners (`providers/owners.ts`, `resolveGoneOwners`): a repository can
  vanish on its own, or because its whole owner did: a deleted or suspended
  account takes every repository it owned with it, and the two read the same
  from a failed fetch. For gone repositories only, amber asks the forge
  whether the owner (the first path segment) still exists: GitHub `GET
  /users/{owner}`, which answers for users and organizations alike and says
  404 for a deleted or suspended account; Gitea the same way. One lookup per
  forge and owner covers every gone repository of that owner, at most 20
  owners per account-sync tick, rechecked every 6 hours because accounts get
  hidden and restored. A failed lookup is not an answer. The API reports it
  as `ownerGone` (null for a repository that is not gone, or that went gone
  again after the last answer), and the Removed page shows "account removed"
  for it, unless the forge named a DMCA takedown, which wins.
- Every sync records a `sync_runs` row + updates repo denormalized fields +
  `disk_usage_bytes` (recursive du, after the fetch) and emits an SSE event.

## Hardened git spawn wrapper (sync/gitCli.ts)

The ONLY way any code runs git. Rules (see https://git-scm.com/docs/git security
notes; amber must be safe against malicious forges AND malicious repos):

- `execFile`/`spawn` with argument arrays. Never a shell. Never repo-controlled
  strings as flags (paths passed after `--` where applicable).
- Credentials: NEVER in argv or stored remote URLs. Repos get their remote URL
  stored credential-free; per-invocation auth uses one-shot env:
  `GIT_ASKPASS=<bundled askpass script>`, with the username/password passed via
  process env vars (`AMBER_GIT_USER`/`AMBER_GIT_PASS`) that the askpass script
  echoes. `GIT_TERMINAL_PROMPT=0` always.
- Environment scrubbed and pinned: `GIT_CONFIG_NOSYSTEM=1`, `HOME` pointed at an
  amber-owned empty dir (so no global git config is picked up),
  `GIT_ALLOW_PROTOCOL=https:http`, `GIT_LFS_SKIP_SMUDGE=1` globally.
- Per-invocation `-c` config: `protocol.version=2`, `fetch.fsckObjects=true` is
  NOT enabled by default (it breaks real-world repos like older kernels) but
  `transfer.credentialsInUrl=die` is set; `submodule.recurse=false`,
  `fetch.recurseSubmodules=no`; for any working-tree operation additionally
  `core.hooksPath=<empty dir>`, `core.fsmonitor=false`, and smudge filters off.
- Timeouts: every git process gets a hard kill timer (default 1h for fetch/clone,
  10 min for plumbing) and is tracked for graceful shutdown.
- Output captured (bounded buffers), classified, logged at debug level with
  credentials structurally impossible to leak (they never enter argv/URLs).

## Read-only git remote (gitremote/routes.ts)

Smart HTTP v2, native `git clone` UX. The routes are always registered; the kill
switch (`git_remote.enabled`, admin only) decides whether they answer. Endpoints:

- `GET /git/:slug/info/refs?service=git-upload-pack` ->
  `git upload-pack --stateless-rpc --advertise-refs <repodir>` with
  `GIT_PROTOCOL` forwarded from the `Git-Protocol` header;
  content-type `application/x-git-upload-pack-advertisement` + service header line.
- `POST /git/:slug/git-upload-pack` -> `git upload-pack --stateless-rpc <repodir>`,
  request body piped to stdin (transparently gunzipped when
  `Content-Encoding: gzip` - git clients send gzip), stdout streamed back as
  `application/x-git-upload-pack-result`. No request body buffering to disk.
- `:slug` accepts the repo slug with optional trailing `.git`.
  Clone URL shown in UI: `https://<user>:<pass>@<PUBLIC_ORIGIN host>/git/<slug>.git`,
  where user and password are the caller's own credential.
- Anything else under `/git/` (notably `service=git-receive-pack` or
  `POST /git-receive-pack`) -> 403 with a plain explanation, AFTER the same
  authentication as every other /git request: an anonymous request for it gets
  the 401 challenge, not the 403, so the surface says nothing to someone who
  is not signed in. receive-pack is never spawned anywhere in the codebase;
  read-only holds by construction.
- Auth: HTTP Basic, per user (`gitremote/auth.ts` is the contract; the order is
  listed under "Git remote, per user" in the multi-user section). Each user with
  the `git` permission mints their own credential: a random 10 character
  lower-case alphanumeric username (stable across rotations and revokes) and an
  autogenerated 32 character base58 password (`crypto.randomBytes`), stored ONLY
  as a scrypt hash (N=2^15, r=8, p=1, `timingSafeEqual`) and shown once by
  `POST /api/git-remote/rotate`. No user-supplied passwords. A request without
  credentials is the normal first leg of a clone and gets 401 with
  `WWW-Authenticate: Basic` without spending a throttle token; a wrong
  password, an unknown username, a removed user, one without `git` and one who
  left the access policy all get the same 401. Failure throttling
  (`gitremote/throttle.ts`, in-memory token buckets) answers 429 before any
  derivation: every failure spends a token from the ADDRESS bucket (30, the CPU
  guard, never cleared by a success, so one valid credential cannot reset the
  guessing budget for other usernames) and from the (address, username) bucket
  (10). A success clears only its own pair and remembers it as known good for 7
  days; a known-good pair is let through a dry address bucket (its own bucket
  still applies), so someone spraying guesses from a shared address cannot lock
  a user out of an address they already log in from. The challenge leg (no
  credentials) is never throttled, since a real clone always starts with it.
  Both maps are bounded, and an IPv6 client is keyed by its /64 in both (a
  host routinely holds a whole /64 and could take a fresh address per guess).
  The address is `request.ip`, with `trustProxy` set to a function
  (`security/trustedProxies.ts`) that believes exactly ONE hop, and only from a
  peer in the `TRUSTED_PROXY_CIDRS` allow list (default loopback only): behind
  cloudflared that is the client address Cloudflare reported, never the
  left-most `X-Forwarded-For` entry a client writes itself, and a LAN client
  (or every client behind docker's bridge NAT) that is not the listed proxy
  cannot set its own. A function rather than a hop count because Fastify 5
  treats a numeric `trustProxy` as "trust nothing".
- Visibility: after authentication the slug must resolve and the user must be
  able to view that repo (`canView`); anything else is the same 404 as an
  unknown slug.
- Disabled (the kill switch off): all /git routes return 404, before any
  credential is read. Turning it off keeps everyone's credential hashes (only the
  switch flips), and a user can still create, rotate or revoke theirs while it is
  off; nothing can be cloned until it is back on. The switch lives in the UI
  (`manage_settings`); it is off by default.
- CF Access: main app enforces SSO; a second CF Access application scoped to
  the deployment host's `/git` path carries a Bypass policy so git clients reach
  basic auth.

## Export (export/archive.ts)

- `GET /api/repos/:id/export/source.<fmt>` - the repo source tree at a ref
  (default: default branch): `fmt` in `zip`, `tar.gz`, `7z`.
  zip/tar.gz streamed with `archiver` from a `git archive`-extracted temp view or
  directly via `git archive --format` for tar/zip (preferred: git archive does
  zip and tar natively; gzip via zlib stream). 7z: temp dir + `7z a` (the 7zip package in
  the image), streamed back, temp cleaned in `finally`.
- `GET /api/repos/:id/export/gitdir.<fmt>` - the FULL backup (bare repo dir as-is,
  including refs/amber archives) as zip/tar.gz/7z. This is the "restore everything"
  export.
- Folder download (browser File System Access API): `GET /api/repos/:id/tree?ref=`
  returns a paged file manifest; `GET /api/repos/:id/blob?ref=&path=` streams one
  file (`git cat-file`/`git show` via wrapper, path validated against the manifest,
  never touching the filesystem via user paths). Web UI walks the manifest writing
  into a user-picked local directory (Chromium only; feature-detected).

## Repository browser (browse/*.ts, routes/browse.ts)

A read-only view of what a backup holds: files, history and diffs, served from
the backup directory with git plumbing. The contract (queries, answers, caps)
is pinned in `shared/src/browseTypes.ts`. Repositories are HOSTILE INPUT here:
amber backs up arbitrary repositories, including ones taken down for cause, and
names, paths, messages and file contents are all attacker-controlled.

- `GET /api/repos/:id/browse/refs?kind=branch|tag&q=&limit=` - refs of one
  kind, newest first with the default branch pinned on top, each with the
  commit it points at (annotated tags peeled). Also `head` (tip of the default
  branch, else HEAD), the total branch and tag counts, and `shallow`.
- `GET .../browse/resolve?rev=<free text>` - a branch, tag, full ref name, or
  short or full sha, to a commit id; 404 when the backup does not hold it.
- `GET .../browse/contents?rev=&path=` - a directory listing (one level,
  directories first) or a file. A file says how to show it (`text`,
  `markdown`, `image`, `binary`) and carries its text when it is UTF-8 and at
  most 1 MiB. Symlinks show their target, submodules are listed but not
  followed, LFS pointers are flagged.
- `GET .../browse/raw?rev=&path=&inline=1` - the bytes of one file.
- `GET .../browse/commits?rev=&path=&limit=&skip=` - history from a commit,
  optionally only what touched a path. Paged by OFFSET into one walk (`next`
  is the next `skip`): a commit id never changes what it names, so the walk is
  the same every time, whereas restarting the walk at a cursor commit drops
  whatever was still queued on the other side of a merge.
- `GET .../browse/commit?rev=` - one commit with its diff against the first
  parent, per file, with caps and `truncated` flags. At the edge of a shallow
  backup there is no parent to compare with, and it says so (`missingParents`)
  instead of showing the whole tree as added.

Rules that make it safe:

- No caller-supplied NAME ever becomes a git argument. `refs` and `resolve`
  are the only endpoints that see names, and they only compare them, as
  strings, against git's own `for-each-ref` listing. Every other endpoint
  takes `rev`, accepts nothing but a full hex commit id, and checks that it
  names a commit in this backup.
- No caller-supplied PATH touches the filesystem. A path is a literal pathspec
  after `--` (`GIT_LITERAL_PATHSPECS=1`), accepted only on exact equality with
  what `ls-tree -z` printed, and the object is then read by id.
- `GIT_NO_REPLACE_OBJECTS=1`, so a `refs/replace/*` ref cannot change what an
  id names. Diffs run with `--no-ext-diff --no-textconv`, so a repository's
  `.gitattributes` can never make git run anything, and with an empty
  attribute source (`GIT_ATTR_SOURCE`) so it decides nothing at all. That
  variable needs git 2.41: an older git ignores it without a word, and a
  `full` mode backup's own `.gitattributes` could then mark a file as binary
  in a diff. The image is built on Debian trixie (git 2.47) for that reason,
  and the image build fails if its git is ever older than 2.41. The first
  images were on bookworm, whose git 2.39 no test had ever run against: tests
  use whatever git the developer or CI machine has, which is always newer
  than a stable Debian's.
- Every git process has a byte cap that truncates with a flag rather than
  failing, a 30 second timeout (answered as 504), and is killed when the
  client disconnects. At most 4 run at once across all browse requests; the
  rest queue inside the same 30 second budget. Diffs run with
  `core.bigFileThreshold` at 1 MiB, so a larger file is reported as binary
  instead of being loaded to diff: a 4 MB repository holding a 200 MB text
  file once cost 1.3 GB of memory for one commit view.
- Commit times are clamped to what a JS Date can hold. A commit dated in the
  year 318857 passes `git fsck` and must not break the history it is in.
- A full-length object id typed into `resolve` wins over a ref of the same
  name, so a branch named like another commit's id cannot stand in for it.
- Known limits: a file name that is not valid UTF-8 is listed with
  replacement characters and cannot be opened; and "Download zip" is `git
  archive`, which honors the archived tree's own `export-ignore` and
  `export-subst` attributes (as GitHub's zip download does), so it can omit
  or rewrite files the browser shows. The full-backup export is exact.
- `raw` is never a script host. Every answer carries `nosniff`,
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox` and `Cross-Origin-Resource-Policy: same-origin`, so a file opened
  in its own tab gets a unique origin and no script. It is an attachment
  (`application/octet-stream`) unless `inline=1` names one of a short list of
  image types AND the bytes really are that type (magic bytes for raster
  images; an SVG must be UTF-8 text); the content type is the server's choice
  from the extension, never sniffed and never the caller's.

## REST API (all JSON under /api, zod-validated bodies/queries)

- Unauthenticated: `GET /healthz` (also used by docker healthcheck).
- Basic-auth realm: `/git/*` only.
- Everything else requires a valid CF Access JWT (see Security) AND an accepted
  identity (the admin, or a user the access policy admits). Every route declares
  what it needs in its Fastify route config (`config.authz`: `public`, `user`,
  `admin`, or one permission key); one hook under `/api` enforces it and a test
  walks the live route table. Object-level checks (`canView`, ownership) happen in
  the handler. An object the caller cannot see answers 404, never 403; 403 is for
  an object they can see but may not change, or a missing permission.
- Resources:
  - `GET /api/me` - `{ id, email, isAdmin, permissions, storage: { usedBytes,
    capBytes, overCap, atCeiling }, policy }`; `policy` (`configured`, `fetchedAt`, `stale`,
    `editUrl`, `lastError`) is null for everyone but the admin.
  - `GET /api/users`, `PATCH /api/users/:id` `{ permissions?, storageCapBytes? }`,
    `POST /api/users/refresh`, `POST /api/users/:id/adopt-repos`,
    `POST /api/users/:id/revoke-git` - all admin only.
  - `GET /api/forges` (any user), `POST /api/forges` and `PATCH/DELETE
    /api/forges/:id` (`manage_forges`; only the admin may set `allowPrivateNetwork`).
  - `GET/POST /api/accounts`, `PATCH/DELETE /api/accounts/:id`,
    `POST /api/accounts/:id/default`. Secrets are write-only: responses carry
    `hasSecret: boolean`, never the secret. List and read return the caller's own
    accounts; `manage_forges` and the admin see everyone's (with `ownerEmail`).
    Create, edit and set-default need `import_private` and act on the caller's OWN
    accounts only, the admin included; delete is the owner's or `manage_forges`.
  - `POST /api/import/preview` (text blob -> per-line parse results),
    `POST /api/import` (commit; returns created/updated/failed per line); both need
    `import`. A refused line carries an optional machine-readable `code`:
    `host_not_enabled`, `host_not_allowed` (with `reason`, the egress
    category), `storage_cap_reached`, or a domain error code. The generic
    "Amber could not import this repository" refusal deliberately has none.
    Re-importing something the caller can already view answers status ok, action
    `updated`, with the message "Already backed up. Nothing was changed.".
  - `GET /api/repos` - server-side pagination
    (`page`, `perPage<=200`, `sort`, `dir`, `q`, `forgeId`, `state`, `outcome`,
    `gone` - true for only the repositories gone upstream, false for the rest,
    `mine` - only the caller's own, and for the admin only `ownerId` and
    `ownerRemoved` - anyone else sending them is refused), returns rows + total.
    The list and its total are filtered IN SQL to what the caller can view.
    Every row also carries `mine`, `isPrivate` and, for the admin only, `owner`
    (`{ id, email, removed }`). `sort` includes `fork_parent`, non-forks last. `q` is a case-insensitive substring of the path or
    display name; when it is a pasted repository URL (any scheme, scp syntax,
    a `user@` prefix, `.git`, a trailing slash, a query string, or a deeper
    page such as `/tree/main`) it also matches by forge host plus path, so
    the URL finds its repo and an owner URL lists that owner's repos. Each row is DENORMALIZED with four read-only extras
    the listing renders and `repos` does not store: `cloneMode` and
    `syncEnabled` (layered settings, batch-resolved for the whole page in one
    pass per scope) plus `lastOutcome` and `lastErrorKind` (from the newest
    `sync_runs` row). They are optional on the shared schema because only this
    endpoint populates them; the single-repo reads return the row as stored.
    A row with a `forkParent` also carries `forkParentRepoId`: the id of the
    repo row backing up that upstream on the same forge (path matched without
    regard to case), or null when amber does not track it. `GET
    /api/repos/:id` carries it too, so a row refreshed in place keeps it. `GET /api/repos/:id`, `PATCH /api/repos/:id`
    (pause/resume, override account, force_anonymous, rename `path`),
    `DELETE /api/repos/:id` (`?files=true` also removes the backup dir),
    `POST /api/repos/:id/sync` (sync now), `GET /api/repos/:id/runs` (paged; a
    read, so anyone who can view the repo may see its history). Who may change a
    repo is in "Permissions"; `path` and a non-null `account_override_id` are the
    owner's or the admin's only.
  - Bulk: `POST /api/repos/bulk` `{ ids, action: pause|resume|sync|delete }`
    answers `{ action, requested, affected, ids, missing, refused? }`. `missing`
    are ids that do not exist or that the caller cannot view (indistinguishable);
    `refused` (`{ id, error, message }[]`) are ids the caller can view but may
    not act on.
  - `GET /api/settings/:scopeType/:scopeId?` (any user; repo scopes need view
    access, account scopes the owner or `manage_forges`) and `PUT` (the global
    scope needs `manage_settings`, the forge scope `manage_forges`, a repo scope
    the right to edit that repo, an account scope the account's owner or
    `manage_forges`), validated against registry allowed-scopes;
    `GET /api/repos/:id/effective-settings` (explain).
  - `GET/POST /api/account-syncs`, `PATCH/DELETE /api/account-syncs/:id`,
    `POST /api/account-syncs/:id/run`. POST takes `accountId` for owned and
    starred syncs (`forgeId` rejected), `namespace` plus `forgeId` and/or
    `accountId` for namespace syncs (both must agree on the forge), and
    `forgeId` plus optional `topN` (default 25) and `windowDays` (default 3)
    for trending syncs (`accountId`, `namespace` and `visibility` rejected). Create
    needs `import`, a trending sync needs `manage_settings`, and a pinned account
    must be the caller's own. A user lists their own syncs and every trending sync
    (the admin lists all, with `ownerEmail`); PATCH, DELETE and run are the
    owner's or the admin's, except that a trending sync is instance-level: anyone
    with `manage_settings` may change, delete or run one whoever owns it, and
    nobody without it may.
    `intervalMinutes` defaults to 360, or 1440 for a trending sync. A duplicate
    is a 409. PATCH edits only `visibility`, `enabled`, `intervalMinutes` and,
    on a trending sync, `topN`; the identity fields are stripped.
  - `GET /api/git-remote` - the CALLER'S own credential (`{ enabled, username,
    hasPassword, rotatedAt, cloneUrlTemplate }`; `enabled` is the instance kill
    switch; the template carries `{password}` and `{slug}` placeholders),
    `POST /api/git-remote/rotate` (mint or rotate mine; the only response that
    carries a password, once, as `{ ...the above, username, password }`),
    `POST /api/git-remote/revoke` (delete mine) - all need `git` and work while
    the remote is off - and `POST /api/git-remote/enable|disable` (the kill switch,
    `manage_settings`). There is no username rename and no path parameter: nothing
    can name someone else's credential; the admin revokes anyone's with
    `POST /api/users/:id/revoke-git`.
  - `GET /api/push` (`publicKey`, `devices`: push service host, user agent and
    last delivery per subscribed browser of the CALLER - never an endpoint or
    key; subscribe, unsubscribe and test likewise act on the caller's browsers),
    `POST /api/push/subscriptions` (a browser's `{ endpoint, keys }`; https
    endpoints only, and the endpoint must pass the egress rule, else 403
    `host_not_allowed`; idempotent), `POST /api/push/unsubscribe` `{ endpoint }`
    (in the body, since the endpoint is a capability that does not belong in a
    URL), `POST /api/push/test` (sends a test notification; answers
    `{ sent, failed }`). A device's `lastError` is one of a few fixed
    categories, never the push service's status or body.
  - `GET /api/repos/:id/browse/*` - see "Repository browser".
  - `GET /api/status` - version, queue depth, active syncs, totals (repos, gone
    repos, disk, filtered to what the caller can view), breaker state,
    insecure-mode flag.
  - `GET /api/events` - SSE stream, filtered per user at SEND time (a permission
    change takes effect on a stream that is already open; a removed user's stream
    is closed; `account_sync.finished` goes to the sync's owner and the admin;
    `status.changed` is instance-wide). Frames are `{ type, at, payload }`, framed
    with a named `event:` line so a client can dispatch without parsing first.
    The payload contract is pinned in `shared/src/apiTypes.ts`
    (`eventPayloadSchemas`) and tested on BOTH sides. Every repo-scoped event
    names its subject `repoId`, never `id`, so one client-side parse covers
    all of them:

    | type                    | guaranteed payload                          |
    | ----------------------- | ------------------------------------------- |
    | `sync.started`          | `{ repoId }`                                |
    | `sync.finished`         | `{ repoId, outcome }`                       |
    | `repo.created`          | `{ repoId }`                                |
    | `repo.updated`          | `{ repoId }`                                |
    | `repo.deleted`          | `{ repoId }`                                |
    | `repo.gone`             | `{ repoId }`                                |
    | `account_sync.finished` | `{ accountSyncId }`                         |
    | `status.changed`        | `{ activeSyncs, queueDepth, breakerOpen }`  |

    The envelope stays an open record, so a publisher may attach extra
    diagnostic fields (`runId`, `slug`, `durationMs`) without breaking a
    client. `status.changed` is published by the scheduler after every state
    change and deduped against the last published triple, so an idle instance
    re-arming its timer does not emit a stream of identical events.

  Collection shapes are deliberately not uniform and are pinned in shared:
  `/api/forges` and `/api/accounts` answer with BARE ARRAYS, `/api/account-syncs`
  answers with a `{ rows }` envelope, and the paged endpoints answer with
  `{ rows, total, page, perPage }`.

## Web push (notify/push.ts)

Tells subscribed browsers when a repository goes gone upstream. Standard Web
Push (RFC 8030) with VAPID (RFC 8292) through the `web-push` package, with
amber as its own application server: no third-party account and nothing to
configure.

- The VAPID key pair is generated on first use and stored in `kv`. The private
  key is instance state like the git remote password hash: it never appears in
  a response or a log. The VAPID contact is `PUBLIC_ORIGIN` when that is https,
  otherwise a placeholder mailto (push services reject a malformed contact).
- Each browser subscribes for itself from the Removed page: it registers
  `/sw.js`, asks permission, subscribes with its push service, and posts the
  subscription to amber. An already subscribed browser re-posts on every visit,
  so a restored database heals itself.
- The notifier listens on the event bus through `EventBus.tap`, a server-side
  listener that is deliberately not counted in `subscriberCount` (which stays
  the number of connected SSE clients). The sync engine and the notifier never
  import each other.
- Gone repositories are batched for 30 seconds and sent as ONE notification
  ("3 repositories are gone upstream: ..."). An expiring token makes every
  private repository on a forge look gone one after another; those that cross
  the line together must be one push, not hundreds. A notification about a
  single repository that GitHub took down over a DMCA notice says so ("was
  removed by a DMCA takedown") instead of "can no longer be fetched".
- EGRESS. A push endpoint is a URL any user's browser hands Amber, which Amber
  later POSTs to, so it gets the restricted-forge rule: https on 443, a public
  DNS name, every resolved address public. It is checked when the subscription
  is saved (403 `host_not_allowed` otherwise) and again at every send, and the
  connection is pinned to the addresses that passed. A failed send stores and
  returns one of a few fixed categories (refused, rejected, timeout,
  unreachable), never the push service's status line or body, so "send me a
  test" cannot be used to learn what an arbitrary URL answers.
- A push service answering 404 or 410 means the subscription is dead and its
  row is deleted. Any other failure is recorded on the row and retried on the
  next notification. A failed notification never fails a sync.
- The service worker (`web/public/sw.js`, plain JS, served from the root
  because its path is its scope) only shows notifications and opens the
  Removed page on tap. It has no fetch handler and caches nothing, so it can
  never serve a stale app. `web.ts` serves everything outside `/assets` with
  `no-cache`, so the worker, the manifest and the icons are revalidated.
- iOS delivers web push only to a site added to the Home Screen, hence the
  manifest (`manifest.webmanifest`, linked with `crossorigin="use-credentials"`
  because it sits behind the same SSO as the app). Push delivery itself goes
  from the push service to the browser and never touches Cloudflare Access.
- SSRF: a subscription endpoint is a URL amber later POSTs to. It must be
  https, it is only accepted from an authenticated session, and the body sent
  to it is encrypted to that subscription's own key.

## Security model

- CF Access JWT middleware (`security/cfAccess.ts`) on every route EXCEPT
  `/healthz` and `/git`. Note the exemption covers the BARE `/git` as well as
  `/git/*`: the Cloudflare Access bypass application is scoped by destination
  path, and a bypass on `/git` applies to `/git` itself too. The middleware has
  to agree with that scoping exactly - when it exempted less than the edge
  bypassed, bare `/git` answered 401 demanding authentication that could never
  arrive, because Cloudflare had already waved the request through.
  The boundary is a PATH SEPARATOR, never a character count, so `/git` does not
  cover `/gitfoo` and, importantly, does not cover `/git-remote`, which is a
  page in the SPA and stays authenticated. `isPublicPath` implements that rule
  and is shared with the SPA fallback so the two cannot disagree.
  Everything the SPA is served from sits BEHIND this middleware: the static
  assets and the client-route fallback are as authenticated as the API. Verification with `jose`: JWKS from
  `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` via
  `createRemoteJWKSet` (built-in caching/kid-refresh), `jwtVerify` enforcing
  `iss = https://<team domain>`, `aud = CF_ACCESS_AUD`, exp/nbf with small skew;
  then the required `email` claim is resolved to an identity (`security/identity.ts`):
  `AMBER_ADMIN_EMAIL` is the admin (accepted on any valid token; the legacy
  `CF_ACCESS_ALLOWED_EMAILS` only supplies the admin, as its first entry, when
  `AMBER_ADMIN_EMAIL` is unset), and anyone else must be a user the Cloudflare Access
  policy admits (see "Multi-user access control"): not a member is 403 `not_a_user`, a
  policy that cannot be read is 503 `policy_unavailable`. Token from
  `Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie. A bad token -> 401,
  fail closed, log at warn.
- Startup refuses to boot when CF vars are missing, UNLESS
  `INSECURE_ALLOW_PUBLIC_ACCESS=1`: then auth is skipped, the server binds
  127.0.0.1 ONLY (hard-coded, overriding PORT/HOST binds), logs a loud warning
  banner at startup and every 10 minutes, and `GET /api/status` reports
  `insecureMode: true`, which the web UI renders as a permanent undismissable red
  banner. Localhost traffic is NEVER otherwise treated as authenticated.
- Account credentials: AES-256-GCM under `AMBER_SECRET_KEY` (64 hex chars in .env).
  Startup fails fast if the key is missing/malformed when secrets exist.
- Git remote passwords: one per user, scrypt-hashed (never stored or logged in
  plaintext), deleted when the user leaves the access policy.
- Authorization: every route declares its requirement, repo visibility is decided in
  SQL and by `canView`, and an object a caller cannot see is a 404 (see
  "Multi-user access control").
- No secrets in: git argv, stored remote URLs, logs, API responses, error messages.
- Credential misdirection (a compromised web UI must not be able to exfiltrate a
  stored PAT by pointing it at an attacker host):
  - `forges.protocol/host/port` are IMMUTABLE after create. PATCH /api/forges/:id
    may change `kind` only. Changing a host means creating a new forge (with no
    credentials) and re-importing.
  - `accounts.forge_id` is IMMUTABLE - credentials can never be moved to a
    different forge. Secret updates only overwrite in place.
  - `repos.forge_id` is IMMUTABLE - a repo cannot be re-pointed at another forge
    while inheriting that forge's or its override account's credentials.
    `repos.path` may be edited (renames), which stays on the same host.
  - A credential is only ever presented to its owning forge's origin. The
    redirect rule depends on the forge's tier (see "Forges and outbound
    requests"): a restricted forge outside the well-known list follows no
    redirect at all (`http.followRedirects=false`); a well-known public forge
    and an unrestricted forge use `http.followRedirects=initial`, which DOES
    follow a redirect on the first request, to any host, and then none after
    it. The backstop for that first redirect is the askpass helper: it receives
    the expected host in env and refuses (returns empty) when git's prompt
    names any other host, so a credential never follows a redirect off the
    forge.
- Hostile repository content. The browser shows what is inside backups, so a
  repository's author is an attacker against whoever views it. The layers,
  each assumed to fail:
  - Everything that came out of a repository (names, paths, messages, file
    and patch text) reaches the page as text through Vue interpolation. There
    is no `v-html` and no `innerHTML` in the web app, and every `href` or
    `src` bound from repository data is a URL amber built from an id, a commit
    id and a path.
  - Markdown (`web/src/lib/markdown/`) goes through markdown-it (no plugins),
    then DOMPurify with a short explicit tag and attribute allowlist (no
    `style`, `class`, `id`, forms, media, SVG or MathML), then a rewrite pass
    over the sanitized DOM that replaces every link and image URL with one it
    built: an image must resolve to an image file inside the same tree and is
    pointed at the `raw` endpoint for that repo and commit; a link is http,
    https or mailto, or a path inside the tree. Remote images are never
    loaded (their alt text is shown instead): a backup viewer should not tell
    third parties what is being read, and a repository must not be able to
    make the viewer's browser request arbitrary URLs.
  - The result never enters the app's document. It is shown in `<iframe
    sandbox="allow-same-origin" srcdoc>`: no `allow-scripts`, so nothing in
    the frame can run, and `allow-same-origin` only lets the parent measure
    the content and handle clicks, and lets the frame's images carry the
    session cookie. The frame document carries its own policy, `default-src
    'none'` with `img-src` pinned to that repository's `raw` endpoint. The
    parent cancels every click in the frame and acts on it itself: a tree
    link navigates the browser, an external link opens in a new tab with no
    opener. Where a browser will not run the parent's listener inside a
    script-less frame (WebKit), the links are listed under the frame instead.
  - Rendering is budgeted before the browser parses anything, because the
    HTML parser itself can be made to do minutes of work: a file over 256 KiB,
    or whose markup has more than 10,000 start tags, is shown as source. The
    formatting elements (`b`, `i`, `a`, `code`, ...) reach the parser under
    stand-in names and are renamed back in the sanitized DOM, since an
    unclosed formatting element is re-created by the parser after every later
    block, which is cubic in the hands of an attacker. Images are capped per
    document, their dimensions bounded, and the frame's height clamped.
  - Any failure in that pipeline shows the markdown source as plain text.
  - The app document itself is served with a Content-Security-Policy
    (`APP_CONTENT_SECURITY_POLICY` in `web.ts`): script only from our own
    files (plus the Cloudflare Web Analytics beacon the reference deployment's
    edge injects), no inline or evaluated script, no plugins, no base tag, no
    framing. `style-src` allows inline styles because PrimeVue's styled mode
    injects them.
  - The `raw` endpoint cannot serve active content (see "Repository
    browser").
- Provider API responses are read through a 32 MB cap (`providers/http.ts`
  `readBodyCapped`) before they are parsed, on every path including pinned
  restricted-forge requests: a hostile forge API cannot exhaust memory with an
  endless body. A larger body, or a declared Content-Length over the cap, is a
  provider error (`invalid_response`); an error body is read only up to 64 KB,
  and a redirect's body is never read.
- SSRF note: amber's whole job is fetching user-supplied URLs, so outbound requests
  are inherently arbitrary; mitigations: only http(s) protocols allowed
  (GIT_ALLOW_PROTOCOL), no redirects followed by provider API clients beyond same
  host, only the admin or `manage_forges` may introduce a new host, a forge the
  admin did not explicitly allow is RESTRICTED to public addresses with every
  request validated and pinned (`security/egress.ts`, see "Forges and outbound
  requests"), web push endpoints get the same rule (see "Web push"), and the
  server runs on an isolated docker network with nothing else listening on
  trust-by-source.

## Multi-user access control

Amber is shared between one admin and a small number of trusted-but-limited
users (friends). This section is the locked design. Where it disagrees with an
older passage elsewhere in this document, this section wins and the older
passage is a bug to fix.

### Who is a user

- Cloudflare Access is the only list of who may get in. Amber never stores an
  allow list of its own; `CF_ACCESS_ALLOWED_EMAILS` is replaced by
  `AMBER_ADMIN_EMAIL` and survives only as the upgrade fallback described next.
- The ADMIN is the single email in `AMBER_ADMIN_EMAIL`. It cannot be changed
  from the UI or the API, so no session can promote itself. The admin holds
  every permission, is uncapped, and is accepted on any valid Access JWT
  whatever policy admitted it: editing the friends policy, or a Cloudflare API
  failure, can never lock the admin out.
  Upgrade fallback: when `AMBER_ADMIN_EMAIL` is unset and the legacy
  `CF_ACCESS_ALLOWED_EMAILS` is set, its FIRST entry is the admin and startup
  logs a deprecation warning. Any further entries are ignored.
- Everyone else is a USER exactly while their email is an explicit `email`
  entry in the `include` list of one reusable Access policy. Amber reads that
  policy with `GET /accounts/<CF_ACCOUNT_ID>/access/policies/<CF_ACCESS_POLICY_ID>`
  using `CF_API_TOKEN`, a token whose only scope is "Access: Apps and Policies
  Read". Other include rule types (domains, groups, everyone) cannot be
  enumerated and are IGNORED: a person admitted only by such a rule presents a
  valid JWT and is refused with 403 `not_a_user`.
- `CF_API_TOKEN`, `CF_ACCOUNT_ID` and `CF_ACCESS_POLICY_ID` are set together or
  not at all (startup refuses a partial set). Without them Amber is admin-only:
  every non-admin is refused, and the Users page explains the setup.
- The Users page links to the policy editor, built from the two ids:
  `https://dash.cloudflare.com/<account>/one/access-controls/policies/<policy>/edit`.
- Email addresses live only in `.env` and the database. None is ever committed.

### Policy sync (`security/accessPolicy.ts`)

One in-process object holds `{ emails, fetchedAt }`, mirrored to `kv`
(`access_policy.emails`, `access_policy.fetched_at`) so a restart starts from
the last good list rather than from nothing.

- Background refresh every 5 minutes, plus `POST /api/users/refresh` (admin).
- Every refresh is single-flight with a 15 second timeout. After a failure the
  next attempt waits at least 30 seconds.
- A successful refresh reconciles the `users` table in one transaction: a new
  email gets a row with the default permissions; a row whose email left the
  list gets `removed_at` and has its git password hash DELETED; a row whose
  email came back has `removed_at` cleared (it must mint a new git password).
- THE MEMBERSHIP RULE, used identically by web requests and by git auth for
  every non-admin identity: if the copy is older than 60 seconds, await a
  refresh. If that refresh fails, use the copy when it is less than 5 minutes
  old, and FAIL CLOSED (503 `policy_unavailable`) when it is older. Web is
  already gated by Access at the edge, so the rule mostly matters for git, but
  one rule everywhere means a removed user with a live Access session is out
  within a minute. Worst case call volume is about one policy read a minute,
  against a Cloudflare limit of 1200 calls per 5 minutes.
- On the git path a fail-closed refusal is sent as a `text/plain` body, which
  git prints to the client as `remote: ...` (pinned by a test with a real git
  client). A failed refresh that is covered by a fresh-enough copy is NOT
  shown to the git client: the clone succeeds and there is no channel for a
  warning short of rewriting the pack stream. Every failed refresh is logged at
  warn and surfaced to the admin in `GET /api/me` (`policy.stale`).

### Data model additions (migration 010)

- `users`: `id` PK, `email` TEXT UNIQUE COLLATE NOCASE (stored lower case),
  `is_admin` 0/1 (exactly one row), `permissions` TEXT (JSON object of the
  keys below), `storage_cap_bytes` INTEGER NULL (NULL = the global default),
  `git_username` TEXT UNIQUE NULL, `git_password_hash` TEXT NULL,
  `git_rotated_at` INTEGER NULL, `removed_at` INTEGER NULL,
  `last_seen_at` INTEGER NULL, `cap_notified_at` INTEGER NULL.
  Rows are never deleted: ownership history must survive a removal.
  The admin's email is normally in the policy too. Reconciliation never
  creates a second row for it and never sets `removed_at` on the admin row.
- `repos.owner_user_id`: FK to `users`, RESTRICT. Every repo has exactly ONE
  owner: the user who imported it. There is no co-ownership.
- `forges.allow_private_network` INTEGER NOT NULL DEFAULT 0 (see "Forges and
  outbound requests"). Backfill: 0 for a forge on the default port whose host
  is exactly one of the well-known public forges (github.com, gitlab.com,
  bitbucket.org, codeberg.org; migration 003 seeds the first two on every
  install, so "the admin made it" is not true of them), 1 for every other
  existing forge (the admin made those, and they may be on a LAN). The
  migration repeats the literal list (it cannot import app code); a test
  asserts it matches `WELL_KNOWN_PUBLIC_FORGE_HOSTS` in `security/egress.ts`.
- `repos.is_private` INTEGER NOT NULL DEFAULT 1 and
  `repos.visibility_checked_at` INTEGER NULL.
- `repos.first_clone_gate_path` TEXT NULL: set by a path change, cleared by the
  first successful fetch OF THAT PATH; while set, the next sync is a first
  clone for the cap gate (see "Storage caps"). NULL on every existing repo.
- `accounts.owner_user_id`, `account_syncs.owner_user_id`,
  `push_subscriptions.user_id`: FK to `users`, NOT NULL in effect.
- Backfill: the admin row is created at first boot (the migration cannot know
  the email, so it creates a placeholder admin row that boot fills in); every
  existing repo, account, account sync and push subscription is assigned to
  it. Every existing repo starts `is_private = 1`: nothing is exposed by the
  upgrade, and the visibility pass below flips the confirmed-public ones.
- The instance-wide git credential in `kv` (`git_remote.username`,
  `git_remote.password_hash`, `git_remote.rotated_at`) is deleted.
  `git_remote.enabled` stays as the admin's kill switch.
- `accounts` keeps UNIQUE(forge_id, username): one forge login is registered
  by one Amber user. A second registration is a 409 with a generic message.
  The default-account index becomes per owner:
  `ON accounts(owner_user_id, forge_id) WHERE is_default = 1`. The
  account-sync uniqueness indexes gain `owner_user_id` the same way (the
  trending one stays per forge and window: trending is instance-level).
- No table is rebuilt: with foreign keys on, dropping `accounts` would cascade
  into `account_syncs` (see the migration 004 note).

### Permissions

Stored per user, edited only by the admin. `shared/src/permissions.ts` is the
single definition (keys, labels, descriptions, defaults); the server and the
Users page both read it.

| key                   | grants                                                        | new user |
| --------------------- | ------------------------------------------------------------- | -------- |
| `view_others_public`  | see repos other people own that are public                    | on       |
| `view_others_private` | see repos other people own that are private                   | off      |
| `import`              | import repos, and create owned/starred/namespace syncs        | on       |
| `import_private`      | own forge accounts (PATs) and fetch with them                 | off      |
| `modify_others`       | change settings of, pause, sync and delete repos they can see | off      |
| `browse`              | the file browser, on repos they can see                       | on       |
| `export`              | archive downloads, on repos they can see                      | on       |
| `git`                 | a personal git credential, for repos they can see             | on       |
| `view_removed`        | the Removed page (still limited to repos they can see)        | off      |
| `manage_forges`       | create/edit/delete forges and forge settings; see and delete  | off      |
|                       | other users' accounts (never their secrets)                   |          |
| `manage_settings`     | global settings, the default cap, trending syncs, git on/off  | off      |

Rules that are not toggles:

- VISIBILITY. `canView(user, repo)` is: admin, OR the owner, OR
  (`is_private = 0` AND `view_others_public`), OR (`is_private = 1` AND
  `view_others_private`). Every repo-scoped read, list, count, event, push,
  export, browse and git clone goes through it. A repo a user cannot view
  answers exactly like a repo that does not exist (404), never 403. Lists and
  their totals are filtered IN SQL, never after paging. Derived references
  obey it too: `forkParentRepoId` is null when the caller cannot view the
  parent.
- OWN REPOS. The owner can always see the repo, edit its repo-scope settings,
  pause, resume, sync now, read its run history, rename its path, and delete
  it. `browse`, `export` and `git` still gate those three surfaces, even on
  owned repos.
- OTHERS' REPOS. `modify_others` on a repo the caller can view allows
  settings, pause, resume, sync now, turning `force_anonymous` ON and delete.
  It does NOT allow changing `path`, setting or clearing `account_override_id`,
  or turning `force_anonymous` OFF: each decides what the OWNER'S token fetches
  (clearing an override falls back to the owner's default account, which can
  be wider than the pinned one), so they are owner or admin only, and an
  override may only name an account the repo's owner owns.
- OWNER-DERIVED FIELDS. A viewer who is neither the owner nor the admin reads
  `accountOverrideId`, `managedByAccountSyncId` and `ownerGone` as null, and
  `lastError` (and each run's `error` in the run history) as a fixed marker
  ("The last sync failed. The details are visible to the repository's owner.")
  whenever there is one: those values were chosen or learned with the owner's
  account.
- FORCE ANONYMOUS. Turning `force_anonymous` ON takes a credential away, so
  `modify_others` may do it. Turning it OFF lets the repo resolve the owner's
  own default account, exactly like setting an override, so it is the owner's
  or the admin's call (403 otherwise); on an adopted repo that keeps a
  `modify_others` user from pointing the admin's token at a path a removed
  user chose.
- A PATH CHANGE resets `is_private` to 1 and clears `visibility_checked_at`:
  the row now names a different upstream and nothing is known about it. It
  also puts the repo back through the first-clone cap gate, and is refused
  outright when the owner is at or over their cap (see "Storage caps").
- Bulk actions apply the same rules per repo and report the ones refused.
  Starred-sync auto-removal only ever touches repos owned by the sync's owner.
- USER MANAGEMENT (permissions, caps, adoption, policy refresh) is admin only
  and is not delegable.
- A removed user (`removed_at` set) is refused everywhere, their accounts are
  never used for a fetch, and their account syncs do not run. Their repos stay
  and keep syncing anonymously where that works. The admin sees them under an
  "owner removed" filter on the repo list and can ADOPT them
  (`POST /api/users/:id/adopt-repos`: the admin becomes the owner of every
  repo that user owns, each repo's account override is cleared, and each is
  set `force_anonymous = 1`, since otherwise it would resolve the ADMIN'S
  default account and the admin's token would start fetching paths a friend
  chose; the admin turns anonymous off per repo, deliberately). Nothing is
  deleted automatically.
- An account sync whose owner no longer holds `import` does not run: the
  scheduler skips it, and `POST /api/account-syncs/:id/run` answers 409
  `owner_cannot_import` (the owner's permission decides, not the caller's).
  Admin-owned syncs are unaffected.
- Without `view_removed`, `GET /api/status` reports `goneRepos: 0`, and ANY
  use of the `gone` list filter (`gone=true` or `gone=false`, whose difference
  from the unfiltered list is exactly the gone repos) and `sort=gone_at` is
  refused (403). On repos the caller does NOT own, `goneAt` reads null, the
  error kind (`lastErrorKind` in the list, `errorKind` in the run history;
  not_found and auth are how "gone" shows first) is hidden, and neither the
  `repo.gone` event nor the gone web push is delivered about them. A user
  always sees gone state for the repos they own.

### Credentials are per user

- An account belongs to exactly one user and is used ONLY for repos that user
  owns. No user's token ever fetches on behalf of someone else. This replaces
  the old global "forge default account" rule everywhere.
- A user needs `import_private` to create, edit or use accounts. Without it
  every one of their repos is fetched anonymously.
- `resolveRepoAccount(repo)`: `force_anonymous` -> none. The owner is removed,
  or is not the admin and lacks `import_private` -> none. Otherwise
  `account_override_id` when the OWNER owns that account, else the owner's
  default account on the repo's forge, else none. Layered settings use the
  same account.
- The `user@` import prefix selects among the IMPORTER'S OWN accounts only.

### Forges and outbound requests

Amber's job is fetching URLs it is given, so who may introduce a new host is
an access-control decision.

- Importing from a host Amber already has needs only `import`. A NEW host
  (a new forge row, by import or by the forges API) needs `manage_forges` or
  the admin. Anyone else gets "this host is not enabled on this Amber".
- A forge is RESTRICTED unless `allow_private_network = 1`, and only the admin
  can create a forge with that flag or set it. A `manage_forges` user can only
  create restricted forges, and creation is refused when the forge is not
  plain `https` on 443 or `http` on 80, or when its host is an IP literal or
  resolves to any address that is not public (loopback, private, link-local,
  CGNAT, unique-local, multicast, unspecified, or an IPv4-mapped form of one).
- That creation check alone would be a time-of-check/time-of-use hole (DNS
  can change afterwards), so the rule is ENFORCED AT EVERY REQUEST for a
  restricted forge (`security/egress.ts`): resolve the host, refuse unless
  every answer is public, then pin the connection to the validated address -
  `git -c http.curloptResolve=<host>:<port>:<ip>` for fetches (and
  `ls-remote`), and a pinned lookup for provider API calls.
- Note what `http.followRedirects=initial` (git's default) actually does: it
  FOLLOWS a redirect on the first request, to ANY host, and that host is
  resolved by libcurl itself, unvalidated and unpinned. So redirects are
  decided per tier:

  | tier | which forges | DNS check and pin | git redirects | git-lfs |
  | --- | --- | --- | --- | --- |
  | unrestricted | `allow_private_network = 1` (set by the admin, used by the admin only) | no | `initial` | yes, endpoint forced with `-c lfs.url=<remote>.git/info/lfs` |
  | well-known public | restricted, https on the default port, host exactly github.com, gitlab.com, bitbucket.org or codeberg.org | yes | `initial` | yes, endpoint forced with `-c lfs.url=<remote>.git/info/lfs` |
  | restricted | every other restricted forge | yes | none (`http.followRedirects=false`) | skipped |

  The well-known tier exists because a backup tool needs two things there that
  the plain restricted rule would break: same-host redirects for renamed
  repositories, and LFS content. Those hosts are known public services, so
  following their initial redirect is accepted; the askpass host check still
  keeps a credential from following it off the forge, and the forced `lfs.url`
  keeps a hostile `.lfsconfig` from steering git-lfs. RESIDUAL: git-lfs has
  its own HTTP client, which ignores `http.curloptResolve`, so on this tier
  its traffic is not pinned, and the object download hosts the LFS batch API
  hands back are the forge's to choose and are not vetted. That is accepted
  for these four hosts only. The list is
  `WELL_KNOWN_PUBLIC_FORGE_HOSTS` in `security/egress.ts`, the one place it is
  defined.
- A refusal is 403 `host_not_allowed` with `details.reason`: `scheme`, `port`,
  `ip_literal`, `invalid_host`, `not_public` or `unresolvable`. The message
  names the host and the category, never a resolved address. A refused import
  line carries the same `code` and `reason`.
- An import from a new host, by the admin as by anyone, creates a RESTRICTED
  forge. A host on a private network or an odd port must first be created on
  the forges page by the admin with "allow private network" switched on; the
  import then finds it.
- UNRESTRICTED FORGES ARE FOR THE ADMIN'S OWN USE. Amber fetches from its own
  network position, so on such a forge an anonymous clone already reaches
  whatever that position reaches; a user who could import there could back up,
  own and browse internal repositories. Only the admin may own repos, accounts
  or account syncs on one: anyone else's import line is refused with
  `host_not_enabled` (the same text an unknown host gets, so the refusal says
  nothing about the LAN), and so is creating an account or an account sync
  there (403). As defence in depth the sync itself refuses to fetch a repo on an
  unrestricted forge whose owner is not the admin, and an account sync run
  refuses the same way ("This forge reaches private networks and is for the
  Amber admin's own use", error kind `other`: no breaker effect, never a gone
  signal). The scheduler refuses the same way BEFORE its first-clone size
  lookup, and every background pass that asks a forge API on a repo's behalf
  (fork parent, visibility, size, gone owner: `providers/forks.ts`,
  `providers/owners.ts`) skips such repos in SQL (`ownerMayUseForgeSql`), so
  nothing is asked from Amber's LAN position for anyone but the admin. If the
  admin flips a restricted forge to unrestricted while non-admins own repos
  there, those repos simply stop syncing with that error, and they become
  visible to the ADMIN ONLY, their owner included (`RepoAccessFacts.adminOnly`
  in the one visibility rule, `canView` and `visibleRepoSqlFilter`, so lists,
  totals, detail, runs, browse, export, the git remote and events all follow),
  until the admin adopts or deletes them. Import re-checks the forge inside
  each line's transaction, so a forge flipped mid-import is still refused.
- Flipping a forge to unrestricted also sets `is_private = 1` on every repo of
  that forge, in the same transaction.
- Web push endpoints are vetted by the same rule (https on 443, a public DNS
  name), at subscribe time and again at every send, with the connection
  pinned (see "Web push").
- Editing or deleting forges needs `manage_forges`. `protocol`, `host` and
  `port` stay immutable.

### Private versus public

- `is_private` is the forge's own answer. For forge kinds with a provider
  (GitHub, GitLab, Gitea, Bitbucket) Amber reads the VISIBILITY FIELD of the
  forge's repository metadata, whoever's token asked: a 200 to an
  authenticated request proves nothing by itself. This rides on the existing
  fork-parent pass (`providers/forks.ts`) and is refreshed at most daily per
  repo.
- Where the forge cannot be asked (generic hosts, API failure): a repo whose
  last successful fetch was anonymous is public, on a RESTRICTED forge only;
  anything else stays private. On an unrestricted forge every repo is private,
  whatever any fetch or API answer says.
- Unknown is always private.

### Importing something Amber already has

Repos stay unique per forge and path and have one owner, so a second import
never creates anything:

- The importer can view the existing repo: the line succeeds as "already
  backed up" and changes nothing (not the owner, not the override).
- They cannot view it: the line fails with "Amber could not import this
  repository", the same text an upstream that refuses them produces.

### Storage caps

- A user's USAGE is the sum of `disk_usage_bytes` over the repos they own.
- CAP: `users.storage_cap_bytes`, else the global setting
  `default_user_storage_cap_gb` (default 5). The admin is uncapped.
- At or over the cap, a new repo is refused: manual import lines fail with a
  clear message, and the user's account syncs skip new discoveries. Existing
  repos KEEP SYNCING, up to the hard ceiling below.
- A PATH CHANGE (rename) points a synced row at a different upstream of
  unknown size, and the first-clone gate keys on "never synced", so a rename
  would skip it. A rename therefore sets `repos.first_clone_gate_path`: the
  next sync is a first clone for every gate below (cap check, forge size check,
  one at a time), until a fetch of THAT path succeeds (a fetch of the old path
  finishing after the rename does not clear it). `last_success_at` is left
  alone, so gone detection is unaffected. An owner already at or over their
  cap cannot rename at all: 403 `storage_cap_reached`.
- IN-FLIGHT BUDGET AND FREE-SPACE FLOOR (`sync/diskWatch.ts`). The ceiling
  below only decides whether a sync may START, and one sync can still fill the
  volume (a tiny repository with huge LFS content, which no forge size
  includes; an endless packfile from a hostile forge), as can several parallel
  syncs of one owner. A full volume also stops SQLite (EDQUOT) and crash-loops
  the whole instance. So while a sync runs, a timer (2 s) checks:
  - a capped (non-admin) owner's growth: the sum, over ALL of their syncs in
    flight, of each repo directory's growth since its sync started, against
    `2 x cap - usage`. Past it the sync that noticed is killed (its git process
    tree, through an AbortSignal every git call of the sync carries) with
    "Storage cap exceeded"; the others notice on their next poll.
  - the free space on the backups volume (statfs) against the global-only
    setting `min_free_disk_gb` (default 5, 0 turns it off), for EVERY sync, the
    admin's included. Below it the sync is killed with "Disk nearly full", and
    the scheduler does not start one at all (refused before it starts, like
    the cap gates: no run row, no breaker effect, normal schedule).
  A killed sync is a failed run of kind `disk` (no breaker effect, never a
  gone signal, the ordinary failure backoff), and its partial files are
  removed: git's temporary packs (`objects/pack/tmp_*`, `objects/incoming-*`)
  and git-lfs's `lfs/tmp` and `lfs/incomplete`. The same cleanup runs after a
  sync that timed out. The cleanup treats the tree as hostile: in `full` mode
  the backup directory is a working tree holding whatever the upstream
  committed (an `objects/` directory, symlinks named `lfs` or `objects`), so
  exactly ONE git dir is cleaned, chosen from the detected layout (bare: the
  directory; worktree: its `.git`), every directory walked must be a real
  directory by lstat, every target must resolve under the git dir's realpath,
  and a symlink is removed as a link, never followed. The watch is started
  inside the sync's error handling (a failure to start it still closes the
  run) and stays registered until the final size is on the repo row, so an
  owner's other syncs in flight never miss this sync's growth.
- SIZING. The in-flight budget lets each capped user grow to twice their cap,
  so caps should be sized so that the sum of (2 x cap) over all users stays
  below the free space minus the floor; otherwise one user's allowed growth can
  hold the volume under the floor and stop everyone's syncs, the admin's
  included. The floor measures the BACKUPS volume only (where state and logs
  live is not checked), and a statfs failure fails open (no refusal). Complete objects and refs are never touched, so the
  backup that existed before is intact. `GET /api/status` gives the admin
  `disk: { freeBytes, minFreeBytes, belowFloor }` (absent for everyone else,
  and when the volume cannot be read; an unreadable volume is not treated as
  full).
- HARD CEILING. While a non-admin owner's usage is at or above TWICE their
  cap, none of their repos syncs: each due sync is refused before it starts,
  recorded on the repo as "Storage cap exceeded" (`last_error`, no run row, so
  no backoff growth and no circuit-breaker effect) and retried on its normal
  schedule, until usage drops or the cap is raised. "Existing repos keep
  syncing" stays true, but clone-setting edits on existing repos (full
  history, every ref, LFS, paranoid archives) and growing upstreams could
  otherwise take a capped user past their cap without bound and fill the disk
  for everyone. A cap of 0 is a freeze: that user is at the ceiling with
  nothing stored. `GET /api/me` reports `storage.atCeiling`, and the banner
  says syncing is paused.
- A size is only known after a clone, so a batch of imports would all pass
  that check. Two more gates close it: the cap is re-checked when a
  never-synced repo is about to start its FIRST clone (over the cap, the clone
  does not start and the repo shows "storage cap reached"), and a capped
  user's first clones run ONE AT A TIME. Where the forge reports a repository
  size, a first clone that would not fit the remaining allowance is refused
  up front. One clone of unknown size can still overshoot.
- When a sync moves a user from under to at-or-over the cap, Amber sets
  `cap_notified_at` and sends a web push to that user's browsers and the
  admin's. The user sees a persistent banner (from `GET /api/me`) and the
  Users page marks the row. Dropping back under clears `cap_notified_at`.

### Git remote, per user

- `/git` stays outside Access and stays read-only. The instance-wide
  credential is gone. Each user with `git` mints their own: username is a
  random 10 character lower-case alphanumeric slug (`crypto`, never derived
  from the email or a database id, stable across rotations), password is the
  same 32 character base58 secret as before, scrypt-hashed, shown once.
- Auth order on every `/git` request: kill switch off -> 404. Throttle. Parse
  Basic. Look the user up by `git_username`; when there is none, still run
  scrypt against a fixed dummy hash so timing does not reveal which usernames
  exist. Verify the password. Refuse a removed user or one without `git`.
  Apply the membership rule (admin exempt). Resolve the slug and require
  `canView`; anything else is the same 404 as an unknown slug.
- A credential dies when its email leaves the policy (the hash is deleted on
  the sync that notices, and the membership rule covers the gap before it).
- API: `GET /api/git-remote` (my username, whether I have a password, the
  clone URL template, whether the remote is on), `POST /api/git-remote/rotate`
  (mint or rotate mine; the only response that carries a password),
  `POST /api/git-remote/revoke` (delete mine), `POST /api/git-remote/enable`
  and `/disable` (the kill switch; `manage_settings`). The admin can revoke
  anyone's with `POST /api/users/:id/revoke-git`.

### API

- `GET /api/me`: `{ email, isAdmin, permissions, storage: { usedBytes,
  capBytes, overCap, atCeiling }, policy: { configured, fetchedAt, stale,
  editUrl } }`. `capBytes` is null for the admin. `policy` is null for
  non-admins. `atCeiling` is true at or above twice the cap.
- `GET /api/users` (admin): every row with permissions, cap, usage, repo
  count, `removedAt`, `lastSeenAt`, `hasGitPassword`.
  `PATCH /api/users/:id` `{ permissions?, storageCapBytes? }` (the admin row
  is immutable), `POST /api/users/refresh`, `POST /api/users/:id/adopt-repos`,
  `POST /api/users/:id/revoke-git`.
- `GET /api/repos` gains `ownerId` and `ownerRemoved=true` filters (admin
  only) and `mine=true`. Rows carry `mine: boolean`, `isPrivate`, and for the
  admin `owner: { id, email, removed }`.
- EVERY route declares what it needs in its Fastify route config
  (`config.authz`): `public`, `user` (any accepted identity), `admin`, or one
  permission key. One hook under `/api` enforces it, and a test walks the live
  route table and fails when any route lacks a declaration. Object-level
  checks (`canView`, ownership) happen in the handler through shared helpers
  in `security/authz.ts`, never ad hoc.
- `GET /api/status` totals, the SSE stream and web push are filtered to what
  the caller can view, re-checked at SEND time (a permission change takes
  effect on open streams). `repo.deleted` carries the audience computed before
  the row went away. A stream whose user is removed is closed. `account_sync.finished` goes to the sync's owner and the
  admin. `status.changed` (queue depth, active syncs, breaker) is instance-wide.

### Settled by the implementation

Details this design left open, as the code now does them. Where one narrows or
extends a rule above, this list is the current behavior.

- POLICY RULES. An `exclude` rule that names an email is SUBTRACTED from the
  include list: an excluded address is refused at the edge, and git bypasses the
  edge, so honouring it keeps git from being looser than the web path. A `require`
  rule cannot be evaluated by Amber; its presence is logged once at warn and the
  git remote does not enforce it.
- `policy.stale` (in `GET /api/me` and the Users page) is true when the last
  refresh failed, when there has never been a good read, or when the copy is
  older than two background intervals (10 minutes), so a stopped timer does not
  look healthy. `policy.lastError` carries why, never the API token. In insecure
  mode the policy is the `INSECURE_USER_EMAILS` list and is never stale.
- VISIBILITY, as implemented (`sync/syncRepo.ts` and `providers/forks.ts`). On
  an UNRESTRICTED forge (`allow_private_network = 1`) nothing ever marks a repo
  public, not an anonymous fetch, not the provider pass, not account-sync
  discovery: there, network position is the credential, so "anonymous works"
  only proves Amber can reach it. Every write is guarded on the path that was
  asked about (`AND path = ?`), so a rename landing mid-lookup never receives
  the old path's answer. On a restricted forge, an ANONYMOUS successful fetch
  marks the repo public. An authenticated
  success on a forge Amber cannot ask (generic) marks it private. On a forge with
  a provider, an authenticated success proves nothing and the visibility pass
  decides: it reads the forge's visibility field, and a DEFINITIVE "not visible"
  answer (404, or a 401/403 that is not a rate limit) sets `is_private`, while a
  rate limit, network failure, timeout, 5xx or unparseable body is no answer and
  leaves the flag alone.
- ADOPT works on any non-admin user, removed or not; it is not limited to the
  "owner removed" list the admin finds them through.
- RUN HISTORY (`GET /api/repos/:id/runs`) is a read: anyone who can view the repo
  may see it.
- ACCOUNT EDIT and SET-DEFAULT are owner-only even for the admin; the admin and
  `manage_forges` can read everyone's accounts and delete them, never edit one
  or see a secret.
- TRENDING SYNCS are listed to every user, created and changed with
  `manage_settings` (whoever owns the row), run with their owner's default account
  when that owner may use accounts, anonymously otherwise.
- Turning `git` OFF for a user (`PATCH /api/users/:id`) deletes their git password
  hash, exactly like a revoke: turning it back on needs a freshly minted password,
  never the old one. The username survives. Independently, /git refuses a user
  without `git` with the ordinary 401; see "Git remote, per user".
- The storage-cap "reached" transition notifies by web push both the user and the
  admin; dropping back under the cap clears `cap_notified_at`.
- EMAILS are normalized in ONE place (`normalizeEmail` in `domain/users.ts`):
  trimmed and lower cased, or refused when not plain printable ASCII. The ASCII
  test runs before lower casing, because Unicode case mapping can fold a
  lookalike into an ASCII address (U+212A KELVIN SIGN lower-cases to "k"). An
  identity whose email is refused is 403 `not_a_user`, never the admin; a policy
  entry that is refused is skipped (reconcile logs a count at warn); config
  refuses such an `AMBER_ADMIN_EMAIL` or `INSECURE_USER_EMAILS` entry.
- A `#` anywhere in the raw request target is refused with 400
  `invalid_request` before any other hook. No browser or Cloudflare sends one,
  and the auth hooks cut the path at `#` while the router does not, so
  `/git#x` would otherwise pass as the public `/git` prefix. The SPA fallback
  cuts paths the same way (`requestPathname`) so the two never disagree. An
  absolute-form request line (`GET http://x/api/users`) is still matched to its
  route and goes through that route's permission check (pinned by a raw-socket
  test).

### Known limits

A repository has exactly one copy and one owner per forge and path. So
importing, or renaming a repo to, a path that another user already backs up
privately is refused, and that refusal tells the caller that someone on this
Amber backs up that exact path. The refusal is generic and the caller must
already know the exact path to ask, so it cannot be used to list anything, but
it is a one-bit oracle. Likewise a forge login (forge plus username) can be
registered by only one user: a second registration is a 409, which says that
login is already registered by someone.

Further limits an operator should know:

- `GET /api/forges` lists every forge's host to every user, so the host names
  of the admin's LAN forges are visible to everyone who can sign in (their
  repositories are not).
- A `manage_forges` user's restricted forge must resolve to public addresses,
  but that includes this deployment's OWN public address (a hairpin through
  the edge), and whatever answers there. An operator who cares should not
  grant `manage_forges`.
- Any container on the network listed in `TRUSTED_PROXY_CIDRS` can set the
  address the git throttle sees; keep that range to the proxy alone.

### Insecure mode and tests

- `INSECURE_ALLOW_PUBLIC_ACCESS=1` makes every request the admin, as before.
- For tests and local development only, `INSECURE_USER_EMAILS` (comma
  separated) stands in for the Access policy, and a request may carry
  `X-Amber-Insecure-User: <email>` to act as one of those users. It can only
  ever LOWER a request's privilege (the default is already admin), and it is
  read only in insecure mode, which binds 127.0.0.1.
- Server tests for the real path use the existing `cfAccessGetKey` seam with
  locally signed JWTs and an injected policy fetcher.

## Config (.env / env vars)

`PORT` (8080), `DATA_DIR` (/data; derives `BACKUPS_DIR=$DATA_DIR/backups`,
`STATE_DIR=$DATA_DIR/state`, `LOGS_DIR=$DATA_DIR/logs`, each overridable),
`AMBER_SECRET_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`,
`AMBER_ADMIN_EMAIL` (the admin; required with the two CF_ACCESS vars unless
insecure mode is on), `CF_API_TOKEN` + `CF_ACCOUNT_ID` + `CF_ACCESS_POLICY_ID`
(the three that let Amber read the users policy: set all or none, else startup
refuses; the token's only scope is "Access: Apps and Policies Read"; without
them Amber is admin-only), `CF_ACCESS_ALLOWED_EMAILS` (LEGACY: when
`AMBER_ADMIN_EMAIL` is unset its first entry becomes the admin with a deprecation
warning, the rest are ignored), `INSECURE_ALLOW_PUBLIC_ACCESS`,
`INSECURE_USER_EMAILS` (insecure mode only: stand-in users for tests and local
development, see "Insecure mode and tests"), `LOG_LEVEL` (info),
`PUBLIC_ORIGIN` (used for clone URLs; defaults to http://localhost:8080, so any
real deployment must set it), `TRUSTED_PROXY_CIDRS` (comma separated addresses
or CIDRs whose nearest X-Forwarded-For hop is believed; default loopback only,
`127.0.0.0/8,::1`; set it to the range the reverse proxy connects from, see
"Git remote"),
`WEB_DIST_DIR` (where the built SPA lives; defaults to `web/dist` resolved
against the server module, which is correct both inside the image and when
running from the repo - a deployment never needs to set it, which is why it is
absent from `.env.example`).
`.env.example` documents every deployment-fundamental var; config.ts reads ONLY
through zod validation.
Everything not deployment-fundamental is a DB setting managed in the UI, not env.

## Frontend

- Dark-first amber theme via a PrimeVue preset (`theme/amber-preset.ts`):
  warm near-black surfaces, amber-500/600 primary, honey gradient accents; light
  mode available via toggle (persisted). PrimeVue styled mode, no Tailwind.
- Logo: `web/src/assets/logo.svg` - translucent amber drop with a commit-graph
  inclusion (dots+edges) inside; also exported as favicon.svg/png and used in
  README and the CF Access app icon.
- Pages: Repos (default; dense DataTable, lazy server-side mode, multi-select +
  bulk bar, a sortable "Fork of" column that opens the upstream's own drawer
  when amber backs it up and its page on the forge when it does not, detail
  drawer with runs/errors/settings/export/clone and a Browse tab: a ref picker
  with branch and tag tabs plus a jump box that takes a branch, tag or sha,
  the file tree with the directory's README rendered under it, a file view
  with line numbers, markdown and common images rendered, history, and
  per-commit diffs; the drawer can be maximized to the full viewport on wide
  screens), Removed
  (repositories gone upstream, newest first, with when each was last checked
  and what the forge answered, a GitHub DMCA takedown named as such with a link
  to the published notice, "account removed" when the owner is gone as well,
  the upstream each fork came from when that was learned before it went gone
  (a gone repository answers 404 to the fork lookup too), the same detail drawer for exporting the backup, and the per-device notification
  toggle plus a test button; the sidebar entry carries the gone count), Import
  (textarea -> preview table -> commit), Forges & Accounts (forges + accounts CRUD,
  default badges, write-only password fields; the add/edit account form shows
  forge-kind-specific credential help - for GitHub: link to
  https://github.com/settings/personal-access-tokens/new and instruct: create a
  fine-grained PAT, expiration "No expiration", repository access as broad as you
  want backed up, and under Permissions grant "Contents: Read-only" plus, when
  starred-repo account sync will be used, the Account permission
  "Starring: Read-only" - nothing else (Metadata read-only is added
  automatically); to back up an organization's private repos, the token's
  resource owner must be that organization, which may have to approve it; analogous short notes for GitLab
  (personal access token, read_repository scope), Bitbucket (app password /
  API token with repository read), and Gitea (access token, repository read)), Account Sync (per-account
  enable/visibility/interval, plus whole-user-or-organization syncs with an
  optional pinned account, plus trending syncs that add the top N new
  repositories daily; usable with no accounts at all on GitHub), Settings (global editor + scope pickers, each field
  shows which scope wins), Git Remote (the caller's own username, create/rotate/
  revoke password, one-time password reveal, copyable clone URL template; the
  kill switch card shows only to `manage_settings`), Users (admin only: policy
  status with a refresh button and a link to the Cloudflare policy editor, or the
  setup instructions when the three CF variables are missing; per user the
  last seen time, repo count, usage against cap, whether a git password exists,
  a cap editor, one toggle per permission, "Revoke git password" and "Adopt
  repos"), About/Status. The Repos list adds an owner column and an owner
  filter for the admin and a private/public marker; the detail drawer hides
  Sync, Pause/Resume, Delete and Settings from a viewer who may not change the
  repo.
- Identity first: the `me` store (`stores/me.ts`) loads `GET /api/me` before
  anything else (status poll, SSE) and answers `can(permission)` / `meets(requirement)`.
  The router guard (`NAV_LINKS` and each route's `meta.requires`) hides nav links
  and redirects a page the caller may not use to `/`; the same check runs when
  identity arrives late or a permission is taken away while a page is open. The
  `not_a_user` and `policy_unavailable` refusals render an AccessScreen instead of
  the app. A persistent, non-dismissible CapBanner shows while the caller is at
  or over their cap. This is convenience only: the server enforces everything.
- SSE store keeps the table live (row-level updates, no refetch storms).
- The built SPA is served by the server itself (`server/src/web.ts`), so the
  image is a single process: fingerprinted assets get a one-year immutable
  cache, and any other unmatched GET falls back to `index.html` with
  `no-store` so client-side deep links work and a deploy is picked up
  immediately. The fallback deliberately excludes `/healthz`, `/api` and
  `/git` on the path-separator boundary above - an API typo has to stay a JSON
  404 rather than becoming an unreadable HTML parse error. In development Vite
  serves the app instead and proxies `/api` across, so a missing `web/dist` is
  normal and logged rather than fatal.
- Empty/error/loading states for every async view; toasts for mutations;
  confirmation dialogs for destructive actions (delete repo w/ files, rotate).
- No em dashes in any UI copy. Tagline appears on About + README only.

## Testing

- Vitest projects: `shared` (pure), `server` (unit + integration: real git repos
  created in temp dirs, real node:sqlite on temp files - no mocking of git or db),
  `web` (@vue/test-utils component tests for stores, import preview, settings
  explain, banner logic).
- Paranoid torture suite (`server/test/paranoid.torture.test.ts`): builds a local
  origin (file:// transport is fine for tests via `--no-local` hardening flags),
  then for each atrocity: force-push unrelated history over main, delete branches,
  delete + move tags, drop a commit via rebase + aggressive gc on origin, rewrite
  history entirely, remove LFS objects. After every step: sync, then assert every
  commit/tree/blob/tag SHA ever observed is still readable in the backup
  (`git cat-file -e`), every previously-seen ref tip is reachable from some ref,
  and LFS objects previously fetched still exist. This suite is the paranoid-mode
  acceptance gate and runs in CI on every push/PR.
- Coverage: v8 provider, lines+branches+functions+statements collected across
  server+shared+web. `scripts/coverage-ratchet.mjs` compares against
  `coverage-baseline.json`: fail if any metric drops > 0.5 percentage points.
  Raising the baseline is MANUAL: run `npm run coverage:ratchet:write` and
  commit the result as its own chore commit. CI only checks the ratchet; it
  does not commit anything back.
- Playwright smoke (`e2e/`), run by the `e2e` job in ci.yml on push and PR:
  - `tests/smoke.spec.ts` drives the BUILT server under node with
    INSECURE_ALLOW_PUBLIC_ACCESS=1 (so the default identity is the admin), against the BUILT frontend in a real
    browser: insecure banner on every page, import a real public repository
    through the UI, wait for the first sync to succeed, check the listing
    renders it with its denormalized mode and outcome, download a source zip
    and verify it carries both a local file header and an end-of-central-
    directory record, the admin turns the git remote on and creates their own
    password on the Git Remote page (read once, username a random 10 character
    slug), then a real `git clone` with the real binary, a rejected wrong
    password, and a rejected push.
  - `tests/multiuser.spec.ts` is the access-control suite, through the real UI
    with three identities: the admin (the insecure-mode default) and two friends
    with the default permissions (a browser context or API request carrying
    `X-Amber-Insecure-User: <email>`, honoured only for the addresses in
    `INSECURE_USER_EMAILS`, which the Playwright config sets). The admin's Users
    page lists both and toggles a permission and sets a cap; friend A sees only
    the nav links their permissions allow and is redirected away from `/users`;
    A imports from the loopback fixture forge (a new host is refused) and owns
    the result, re-importing it says "Already backed up"; B sees A's public repo
    but has no Pause/Delete controls and a direct API call is a 403; the admin
    turning off B's `view_others_public` makes it a 404 for B; a repo fetched with
    an account is private and invisible to B; A mints a git password, a real `git
    clone` works for A's repo and fails for one A cannot view, and the admin
    revoking A's password from the Users page makes the clone fail; a user at a
    tiny cap sees the banner and a new import is refused. Fixture forges on
    loopback are registered by the admin as unrestricted
    (`allowLoopbackForge` in `tests/helpers.ts`), since a new host is otherwise
    restricted to public addresses.
  - `tests/browse.spec.ts` drives the Browse tab against repositories the
    suite builds itself and serves over dumb HTTP from a throwaway local
    server (`tests/localGitServer.ts`), so it needs no network: the README in
    its sandboxed frame, in-frame links, file views, history, diffs, the ref
    picker and jump box, the single-ref case, the maximize button, and the
    headers of the `raw` endpoint.
  - `tests/hygiene.spec.ts` visits every route and every drawer tab and fails
    on any console error, page error or Content-Security-Policy violation, so
    a change that needs a looser policy fails here instead of in production.
  - `tests/hostile.spec.ts` is the regression suite for hostile repository
    content, in a real browser: a repository full of script-bearing markdown,
    file names, ref names, commit text, an SVG and a mislabelled HTML file.
    Its detectors (dialogs, a canary function, off-origin requests, frame
    navigations, popups) are proven with a positive control first, then every
    view is walked and nothing may fire.
  - `tests/dockerImage.spec.ts` smoke tests the built image from INSIDE the
    container (`docker exec`): git, git-lfs and 7z present, healthz ok, and the
    root serving the SPA. Skipped unless `AMBER_E2E_IMAGE` names an image.
  - Why the split: INSECURE_ALLOW_PUBLIC_ACCESS binds 127.0.0.1, and a
    published container port DNATs to the container's own interface, so a
    host-side browser can never reach it. Running the server directly for the
    UI flows and probing the image from within sidesteps that without
    weakening the loopback rule.

## CI/CD

- `ci.yml`: push + PR. Jobs: lint+typecheck, test+coverage+ratchet (Node 26),
  compat test job (Node 24), build, and the Playwright e2e smoke (needs build;
  installs chromium and git-lfs; uploads its report on failure). All jobs honor
  GitHub's native `[skip ci]`, which skips the whole workflow run rather than
  needing a per-job guard. Concurrency group cancels superseded runs.
- `build-image.yml`: push to main, path-filtered (server/, web/, shared/,
  Dockerfile, package*.json, workflow file) + workflow_dispatch. Builds
  multi-stage image, smoke-tests it (healthz + `git --version` + `git lfs version`
  - `7z` presence), pushes `ghcr.io/pmaxhogan/amber:latest` + `sha-<short>`.
    permissions: contents read, packages write.
- `dependabot.yml`: npm (root, weekly, grouped minor+patch), docker, github-actions.
- `dependabot-automerge.yml`: on dependabot PRs, if update-type is
  semver-minor/semver-patch -> approve + `gh pr merge --auto --squash`; majors
  stay for manual review. Branch protection on main requires the ci checks, so
  auto-merge waits for green.
- The NAS-wide Watchtower (its own TrueNAS Custom App, one instance for every
  app on the host) pulls `:latest` within ~2 min of publish (label-enable). No
  per-app sidecar: an unscoped Watchtower deletes every other Watchtower at
  startup, so per-app sidecars kept deleting each other (removed 2026-11-08).

## Deployment

- A single data directory (any host path) mounted as `/data`; subdirs
  `backups/`, `state/`, `logs/` created by the app at boot if missing. The
  container needs no root: compose sets `user:` to whichever uid owns that
  directory on the host.
- `deploy/docker-compose.example.yml`: service `amber` (image
  ghcr.io/pmaxhogan/amber:latest, env_file and volume both pointing at the data
  directory, watchtower labels, json-file logging caps, pull_policy always,
  restart unless-stopped). No watchtower service: a comment shows the one
  host-wide Watchtower to run instead.
- Fronted by an authenticating proxy. The reference setup is a Cloudflare
  Tunnel with a CF Access application on the public hostname, plus a second
  Access application on that host's `/git` path with a Bypass Everyone policy
  so git clients reach HTTP basic auth rather than the SSO page.
- The deployment `.env` holds only: PORT, AMBER_SECRET_KEY, CF_ACCESS_TEAM_DOMAIN,
  CF_ACCESS_AUD, AMBER_ADMIN_EMAIL, PUBLIC_ORIGIN, LOG_LEVEL, and, to share
  Amber with other people, CF_API_TOKEN, CF_ACCOUNT_ID and CF_ACCESS_POLICY_ID.
  The reference setup for sharing is one reusable Access policy listing the
  friends' email addresses, attached to the Amber application (and not to the
  `/git` bypass application); removing an address from it removes that person's
  web and git access within about a minute.
