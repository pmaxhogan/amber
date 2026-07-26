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
- Server: Fastify 5. Frontend: Vue 3 + Vite 8 SPA + PrimeVue 5 (+ @primeuix/themes),
  pinia, vue-router. Validation: zod 4 in `shared/`, inferred types on both sides.
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
  security/secrets.ts     # AES-256-GCM encrypt/decrypt for account credentials
  security/gitPassword.ts # scrypt hash/verify + generator for the git remote password
  domain/forges.ts        # forge CRUD + kind detection
  domain/accounts.ts      # account CRUD + default-account invariants
  domain/repos.ts         # repo CRUD + listing query builder (paginate/sort/filter)
  domain/settings.ts      # layered settings resolution
  domain/importer.ts      # URL parsing + bulk import
  sync/gitCli.ts          # hardened git spawn wrapper (askpass, allowlisted flags)
  sync/syncRepo.ts        # single-repo sync: modes, paranoid archival, LFS
  sync/scheduler.ts       # queue, worker pool, stagger, backoff, breaker, startup catch-up
  sync/diskUsage.ts       # du of repo dirs (cached in DB per sync)
  providers/types.ts      # AccountSyncProvider interface
  providers/github.ts     # + gitlab.ts, bitbucket.ts, gitea.ts
  providers/discovery.ts  # account-sync run: enumerate -> upsert repos
  gitremote/routes.ts     # smart HTTP read-only remote (/git/*)
  export/archive.ts       # zip/tar.gz/7z streaming of source, git-archive, file listing
  routes/*.ts             # REST routes per resource (thin; call domain/*)
  events.ts               # SSE broadcaster for live UI updates
web/src/
  main.ts, App.vue, router/, stores/, pages/, components/, theme/
  theme/amber-preset.ts   # PrimeVue theme preset, dark-first amber palette
  assets/logo.svg         # inclusion-in-amber mark
e2e/                      # playwright smoke (runs against built docker image)
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
  `kind` ('github'|'gitlab'|'bitbucket'|'gitea'|'generic'), UNIQUE(protocol, host, port).
  Kind auto-detected from host on create (github.com -> github, gitlab.com -> gitlab,
  bitbucket.org -> bitbucket), user-editable (self-hosted gitea/gitlab).
- `accounts`: `id` PK, `forge_id` FK CASCADE, `username` TEXT,
  `secret_enc` BLOB NULL (AES-256-GCM: 12b IV || 16b tag || ciphertext),
  `is_default` INTEGER 0/1, `last_used_at`. UNIQUE(forge_id, username).
  Partial unique index: `ON accounts(forge_id) WHERE is_default = 1`.
  Invariant (enforced in domain/accounts.ts, tested): a forge with >=1 accounts has
  exactly one default. Deleting the default promotes the oldest remaining account.
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
  `default_branch` TEXT NULL, `last_fetch_head` TEXT NULL.
  UNIQUE(forge_id, path). Re-importing an existing forge+path updates the account
  override instead of erroring (idempotent import).
- `sync_runs`: `id` PK, `repo_id` FK CASCADE, `started_at`, `finished_at`,
  `outcome` ('success'|'error'|'canceled'), `error` TEXT NULL, `error_kind` TEXT NULL
  ('auth'|'not_found'|'rate_limited'|'network'|'timeout'|'disk'|'git'|'other'),
  `bytes_fetched` INTEGER NULL, `duration_ms`, `refs_changed` INTEGER NULL,
  `paranoid_archived` INTEGER NULL. Retention (enforced after each run): keep newest
  50 per repo; error rows additionally kept 30 days regardless of count.
- `settings`: `scope_type` ('global'|'forge'|'account'|'repo'), `scope_id` INTEGER
  NULL (NULL for global), `key` TEXT, `value` TEXT (JSON). UNIQUE(scope_type,
  scope_id, key).
- `account_syncs`: `id` PK, `account_id` FK CASCADE, `source`
  ('owned'|'starred', default 'owned'), `visibility` ('all'|'public'|'private',
  applies to source=owned only), `enabled` 0/1, `interval_minutes` (default 360),
  `next_run_at`, `last_run_at`, `last_error` TEXT NULL, `repos_discovered` INTEGER.
  UNIQUE(account_id, source) - one owned sync and one starred sync may coexist per
  account.
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
- `kv`: `key` TEXT PK, `value` TEXT. Uses: git remote config (enabled, username,
  scrypt password hash), instance id, cached JWKS, schema/state misc.

## Layered settings

Registry lives in `shared/src/settingsRegistry.ts`: each key declares zod schema,
default, allowed scopes, and UI metadata (label, description, group). Keys:

| key                        | default | scopes    |
| -------------------------- | ------- | --------- |
| `clone_mode` ('bare' \| 'full' \| 'shallow' \| 'mirror') | `bare` | all |
| `shallow_depth` (int >=1)  | 1       | all       |
| `sync_interval_minutes`    | 180     | all       |
| `sync_enabled` (bool)      | true    | all       |
| `lfs_enabled` (bool)       | true    | all       |
| `paranoid` (bool)          | false   | all       |
| `max_concurrent_syncs`     | 8       | global    |
| `max_concurrent_per_forge` | 4       | global    |

Resolution order (narrowest wins): repo -> effective account (the override, or the
forge default account; skipped when force_anonymous or no account) -> forge ->
global -> registry default. `domain/settings.ts` exposes
`resolveSettings(repoId)` returning the fully-merged typed object plus, for the UI,
`explainSettings(repoId)` that reports which scope supplied each value.

## Import parsing (shared/src/importUrl.ts, used by server + web preview)

Accepted line formats (one per line, blank lines and `#` comments ignored):

- Full URLs: `https://github.com/nodejs/node`, `http://host:8080/x/y.git`
- Proto-less: `github.com/nodejs/node/` (assume https, default port)
- User prefix: `pmaxhogan@github.com/pmaxhogan/mkvid` or
  `https://b@github.com/d/e` - the user part selects/creates an account override:
  if an account with that username exists on the forge it becomes the repo's
  override; otherwise import succeeds with a warning and no override (do not create
  accounts implicitly).
- Trailing `.git` optional and stripped for identity; `path` is the normalized key.

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
  - `shallow`: bare + `--depth <shallow_depth>`.
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
  - The torture test suite is the acceptance gate (see Testing).
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

Smart HTTP v2, native `git clone` UX. Endpoints (registered only when enabled):

- `GET /git/:slug/info/refs?service=git-upload-pack` ->
  `git upload-pack --stateless-rpc --advertise-refs <repodir>` with
  `GIT_PROTOCOL` forwarded from the `Git-Protocol` header;
  content-type `application/x-git-upload-pack-advertisement` + service header line.
- `POST /git/:slug/git-upload-pack` -> `git upload-pack --stateless-rpc <repodir>`,
  request body piped to stdin (transparently gunzipped when
  `Content-Encoding: gzip` - git clients send gzip), stdout streamed back as
  `application/x-git-upload-pack-result`. No request body buffering to disk.
- `:slug` accepts the repo slug with optional trailing `.git`.
  Clone URL shown in UI: `https://<user>:<pass>@<PUBLIC_ORIGIN host>/git/<slug>.git`.
- Anything else under `/git/` (notably `service=git-receive-pack` or
  `POST /git-receive-pack`) -> 403 with a plain explanation. receive-pack is never
  spawned anywhere in the codebase; read-only holds by construction.
- Auth: HTTP Basic. Username from kv (default `amber`), password autogenerated
  (32 chars, `crypto.randomBytes`, base58) - stored ONLY as scrypt hash
  (N=2^15, r=8, p=1, `timingSafeEqual`), shown once on enable/rotate. Rotation
  re-generates; no user-supplied passwords. 401 with `WWW-Authenticate: Basic`
  when absent/wrong; per-IP failure throttling (in-memory token bucket).
- Disabled (default): all /git routes return 404. Toggle + rotate live in the UI.
- CF Access: main app enforces SSO; a second CF Access application scoped to
  the deployment host's `/git` path carries a Bypass policy so git clients reach
  basic auth.

## Export (export/archive.ts)

- `GET /api/repos/:id/export/source.<fmt>` - the repo source tree at a ref
  (default: default branch): `fmt` in `zip`, `tar.gz`, `7z`.
  zip/tar.gz streamed with `archiver` from a `git archive`-extracted temp view or
  directly via `git archive --format` for tar/zip (preferred: git archive does
  zip and tar natively; gzip via zlib stream). 7z: temp dir + `7z a` (p7zip-full in
  the image), streamed back, temp cleaned in `finally`.
- `GET /api/repos/:id/export/gitdir.<fmt>` - the FULL backup (bare repo dir as-is,
  including refs/amber archives) as zip/tar.gz/7z. This is the "restore everything"
  export.
- Folder download (browser File System Access API): `GET /api/repos/:id/tree?ref=`
  returns a paged file manifest; `GET /api/repos/:id/blob?ref=&path=` streams one
  file (`git cat-file`/`git show` via wrapper, path validated against the manifest,
  never touching the filesystem via user paths). Web UI walks the manifest writing
  into a user-picked local directory (Chromium only; feature-detected).

## REST API (all JSON under /api, zod-validated bodies/queries)

- Unauthenticated: `GET /healthz` (also used by docker healthcheck).
- Basic-auth realm: `/git/*` only.
- Everything else requires a valid CF Access JWT (see Security).
- Resources:
  - `GET/POST /api/forges`, `PATCH/DELETE /api/forges/:id`
  - `GET/POST /api/accounts`, `PATCH/DELETE /api/accounts/:id`,
    `POST /api/accounts/:id/default`. Secrets are write-only: responses carry
    `hasSecret: boolean`, never the secret.
  - `POST /api/import/preview` (text blob -> per-line parse results),
    `POST /api/import` (commit; returns created/updated/failed per line)
  - `GET /api/repos` - server-side pagination
    (`page`, `perPage<=200`, `sort`, `dir`, `q`, `forgeId`, `state`, `outcome`),
    returns rows + total. `GET /api/repos/:id`, `PATCH /api/repos/:id`
    (pause/resume, override account, force_anonymous), `DELETE /api/repos/:id`
    (`?files=true` also removes the backup dir),
    `POST /api/repos/:id/sync` (sync now), `GET /api/repos/:id/runs` (paged).
  - Bulk: `POST /api/repos/bulk` `{ ids, action: pause|resume|sync|delete }`.
  - `GET /api/settings/:scopeType/:scopeId?` + `PUT` same path (validated against
    registry allowed-scopes), `GET /api/repos/:id/effective-settings` (explain).
  - `GET/POST /api/account-syncs`, `PATCH/DELETE /api/account-syncs/:id`,
    `POST /api/account-syncs/:id/run`.
  - `GET /api/git-remote` (enabled, username, cloneUrlTemplate, rotatedAt),
    `POST /api/git-remote/enable|disable|rotate` (enable/rotate return the
    plaintext password exactly once).
  - `GET /api/status` - version, queue depth, active syncs, totals (repos, disk),
    breaker state, insecure-mode flag.
  - `GET /api/events` - SSE stream (sync started/finished, repo added, etc.).

## Security model

- CF Access JWT middleware (`security/cfAccess.ts`) on every route EXCEPT
  `/healthz` and `/git/*`. Verification with `jose`: JWKS from
  `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` via
  `createRemoteJWKSet` (built-in caching/kid-refresh), `jwtVerify` enforcing
  `iss = https://<team domain>`, `aud = CF_ACCESS_AUD`, exp/nbf with small skew;
  then required `email` claim must be in `CF_ACCESS_ALLOWED_EMAILS`
  (comma-separated, case-insensitive). Token from `Cf-Access-Jwt-Assertion` header
  or `CF_Authorization` cookie. Any failure -> 401, fail closed, log at warn.
- Startup refuses to boot when CF vars are missing, UNLESS
  `INSECURE_ALLOW_PUBLIC_ACCESS=1`: then auth is skipped, the server binds
  127.0.0.1 ONLY (hard-coded, overriding PORT/HOST binds), logs a loud warning
  banner at startup and every 10 minutes, and `GET /api/status` reports
  `insecureMode: true`, which the web UI renders as a permanent undismissable red
  banner. Localhost traffic is NEVER otherwise treated as authenticated.
- Account credentials: AES-256-GCM under `AMBER_SECRET_KEY` (64 hex chars in .env).
  Startup fails fast if the key is missing/malformed when secrets exist.
- Git remote password: scrypt-hashed (never stored or logged in plaintext).
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
  - A credential is only ever presented to its owning forge's origin: git fetch
    runs with explicit `-c http.followRedirects=initial` (never follow
    post-initial redirects), and the askpass helper receives the expected
    host in env and refuses (returns empty) when git's prompt names any other
    host. Defense in depth against a malicious forge redirecting to a
    credential-phishing host.
- SSRF note: amber's whole job is fetching user-supplied URLs, so outbound requests
  are inherently arbitrary; mitigations: only http(s) protocols allowed
  (GIT_ALLOW_PROTOCOL), no redirects followed by provider API clients beyond same
  host, and the server runs on an isolated docker network with nothing else
  listening on trust-by-source.

## Config (.env / env vars)

`PORT` (8080), `DATA_DIR` (/data; derives `BACKUPS_DIR=$DATA_DIR/backups`,
`STATE_DIR=$DATA_DIR/state`, `LOGS_DIR=$DATA_DIR/logs`, each overridable),
`AMBER_SECRET_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`,
`CF_ACCESS_ALLOWED_EMAILS`, `INSECURE_ALLOW_PUBLIC_ACCESS`, `LOG_LEVEL` (info),
`PUBLIC_ORIGIN` (used for clone URLs; defaults to http://localhost:8080, so any
real deployment must set it).
`.env.example` documents every var; config.ts reads ONLY through zod validation.
Everything not deployment-fundamental is a DB setting managed in the UI, not env.

## Frontend

- Dark-first amber theme via a PrimeVue preset (`theme/amber-preset.ts`):
  warm near-black surfaces, amber-500/600 primary, honey gradient accents; light
  mode available via toggle (persisted). PrimeVue styled mode, no Tailwind.
- Logo: `web/src/assets/logo.svg` - translucent amber drop with a commit-graph
  inclusion (dots+edges) inside; also exported as favicon.svg/png and used in
  README and the CF Access app icon.
- Pages: Repos (default; dense DataTable, lazy server-side mode, multi-select +
  bulk bar, detail drawer with runs/errors/settings/export/clone), Import
  (textarea -> preview table -> commit), Accounts (forges + accounts CRUD,
  default badges, write-only password fields; the add/edit account form shows
  forge-kind-specific credential help - for GitHub: link to
  https://github.com/settings/personal-access-tokens/new and instruct: create a
  fine-grained PAT, expiration "No expiration", repository access as broad as you
  want backed up, and under Permissions grant ONLY "Contents: Read-only"
  (Metadata read-only is added automatically); analogous short notes for GitLab
  (personal access token, read_repository scope), Bitbucket (app password /
  API token with repository read), and Gitea (access token, repository read)), Account Sync (per-account
  enable/visibility/interval), Settings (global editor + scope pickers, each field
  shows which scope wins), Git Remote (enable, username, rotate, one-time password
  reveal, copyable clone URLs), About/Status.
- SSE store keeps the table live (row-level updates, no refetch storms).
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
  `coverage-baseline.json`: fail if any metric drops > 0.5 percentage points;
  when coverage improves, CI (main only) auto-commits a raised baseline
  (`[skip ci]` in the bump commit).
- Playwright smoke (`e2e/`): compose up the built image with
  INSECURE_ALLOW_PUBLIC_ACCESS=1 (localhost), then: import a small local repo via
  a file-served git http fixture or a public GitHub repo, wait for sync success,
  check listing renders, export a zip, enable git remote, `git clone` from the
  container, assert push is rejected. Runs in CI on main + PRs touching src.

## CI/CD

- `ci.yml`: push + PR. Jobs: lint+typecheck, test+coverage+ratchet (Node 26),
  compat test job (Node 24), web build. All jobs honor GitHub's native
  `[skip ci]`. Concurrency group cancels superseded runs.
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
- Watchtower on the NAS pulls `:latest` within ~2 min of publish (label-scoped,
  same pattern as mkvid).

## Deployment

- A single data directory (any host path) mounted as `/data`; subdirs
  `backups/`, `state/`, `logs/` created by the app at boot if missing. The
  container needs no root: compose sets `user:` to whichever uid owns that
  directory on the host.
- `deploy/docker-compose.example.yml`: service `amber` (image
  ghcr.io/pmaxhogan/amber:latest, env_file and volume both pointing at the data
  directory, watchtower labels, json-file logging caps, pull_policy always,
  restart unless-stopped) plus an optional label-scoped watchtower sidecar.
- Fronted by an authenticating proxy. The reference setup is a Cloudflare
  Tunnel with a CF Access application on the public hostname, plus a second
  Access application on that host's `/git` path with a Bypass Everyone policy
  so git clients reach HTTP basic auth rather than the SSO page.
- The deployment `.env` holds only: PORT, AMBER_SECRET_KEY, CF_ACCESS_TEAM_DOMAIN,
  CF_ACCESS_AUD, CF_ACCESS_ALLOWED_EMAILS, PUBLIC_ORIGIN, LOG_LEVEL.
