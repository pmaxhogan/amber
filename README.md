<p align="center">
  <img src="docs/brand/banner.svg" alt="Amber - git history, preserved." width="820" />
</p>

[![CI](https://github.com/pmaxhogan/amber/actions/workflows/ci.yml/badge.svg)](https://github.com/pmaxhogan/amber/actions/workflows/ci.yml)
[![Build image](https://github.com/pmaxhogan/amber/actions/workflows/build-image.yml/badge.svg)](https://github.com/pmaxhogan/amber/actions/workflows/build-image.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Amber is a self-hosted git backup service. Point it at any HTTPS git remote and
it keeps an up-to-date local copy on a schedule, then serves those backups back
out as a read-only git remote.

## Features

- **Any HTTPS remote.** GitHub, GitLab, Bitbucket, Gitea, or a plain git HTTP
  server. Bulk import by pasting a list of URLs.
- **Account sync.** Link an account and Amber discovers and tracks its
  repositories automatically.
- **Whole users and organizations.** Paste `https://github.com/nodejs` into
  the import box and Amber backs up every repository that user or organization
  owns, picking up new ones as they are created.
- **Trending discovery.** Add a trending sync and Amber backs up the top N
  most-starred new GitHub repositories every day, before they can be taken
  down. Nothing it adds is ever removed.
- **Know when something disappears.** A repository that had synced and then
  stays unfetchable for hours, or that GitHub takes down over a DMCA notice,
  lands on the Removed page (which says whether just the repository went or
  its owner's whole account did), keeps its backup, and sends a push notification
  to every browser you turned notifications on in.
- **Browse a backup.** Read what a backup holds without cloning it: files at
  any branch, tag or commit, rendered READMEs and images, history and diffs.
  Repository content is treated as hostile: markdown is sanitized and shown in
  a sandboxed frame, and nothing a repository contains can run in the app.
- **Fork of.** Each fork shows the repository it came from, linking to that
  repository's own backup when Amber has one.
- **Paranoid mode.** Never lose history. Pruning and garbage collection are
  disabled and every ref tip that upstream rewrites or deletes is archived under
  `refs/amber/archive/<timestamp>/` before the update lands.
- **Clone modes.** Bare, mirror, shallow, or a full working tree, with Git LFS
  objects fetched alongside. A shallow backup can be limited to the default
  branch, so a repository with thousands of branches stays small.
- **Layered settings.** Configure at the global, forge, account, or repository
  scope. The narrowest scope wins, and the UI shows you which one did.
- **Read-only git remote.** `git clone` straight from your backup, with a
  personal credential per person.
- **Share it with friends.** Add a few people and decide what each may do:
  see each other's public repositories, import, browse, export, clone over git,
  with a storage cap per person. Everyone's own repositories and credentials
  stay theirs.
- **Exports.** Download the source tree or the entire backup directory as zip,
  tar.gz, or 7z.
- **Resilient scheduling.** Persistent per-repo schedules, exponential backoff
  with jitter, and a circuit breaker for network outages. A forge being down is
  the reason Amber exists, not a reason to give up on a repository.

## Self-hosting

Prebuilt images are published to GHCR on every push to main:
`ghcr.io/pmaxhogan/amber:latest`. No need to clone or build anything -
[`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) pulls
the image, mounts a data directory, and labels the container for a host-wide
Watchtower (one command in the file's comments) that keeps it current
automatically.

```bash
curl -fsSLO https://raw.githubusercontent.com/pmaxhogan/amber/main/deploy/docker-compose.example.yml
curl -fsSL https://raw.githubusercontent.com/pmaxhogan/amber/main/.env.example -o .env
# Edit docker-compose.example.yml: point the volume and env_file at your data
# directory and set user: to its owner. Fill in AMBER_SECRET_KEY, your
# AMBER_ADMIN_EMAIL and the Cloudflare Access settings in .env, then:
docker compose -f docker-compose.example.yml up -d
```

A fresh install comes seeded with `github.com` and `gitlab.com` forges, so the
first import is just pasting URLs. Both can be removed if you do not want them.

To build from source instead:

```bash
git clone https://github.com/pmaxhogan/amber.git
cd amber
cp .env.example .env
docker compose -f docker-compose.local.yml up --build
```

Amber has no built-in login. It expects to sit behind an authenticating proxy;
the supported setup is a Cloudflare Tunnel with a Cloudflare Access application
in front of it, and the server verifies the Access JWT on every request. The
one address in `AMBER_ADMIN_EMAIL` is the admin.
[`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) is a
starting point for a real deployment.

### Sharing Amber with other people

By default Amber is admin-only. To let a few friends in:

1. Set `AMBER_ADMIN_EMAIL` (for example `you@example.com`) in `.env`. The admin
   holds every permission, is never capped, and cannot be locked out by a
   policy edit or a Cloudflare API outage.
2. In Cloudflare Zero Trust, create a reusable Access policy that lists your
   friends' email addresses (explicit email rules, for example
   `friend@example.com`) and attach it to the Amber Access application. Other
   rule types (domains, groups, everyone) cannot be read by Amber, so someone
   admitted only by one of those is refused.
3. Create an API token with exactly one permission, "Access: Apps and Policies
   Read", and set `CF_API_TOKEN`, `CF_ACCOUNT_ID` and `CF_ACCESS_POLICY_ID` (the
   policy's id) in `.env`. Set all three or none. Restart Amber.
4. Open the Users page. Amber reads the policy every five minutes (the page has a refresh
   button), and each address in it appears with the default permissions and a
   default storage cap of 5 GB. The admin adjusts the
   permissions and the cap per person there, can revoke someone's git password,
   and can adopt the repositories of a user who has left.
5. Each person creates their own git password on the Git Remote page (shown
   once). It only reaches the repositories that person can see. The admin turns
   the git remote on or off for everyone.

Removing an email from the policy removes that person's web and git access
within about a minute, and deletes their git password. Their repositories stay
and keep syncing until the admin adopts or deletes them.

For local development you can set `INSECURE_ALLOW_PUBLIC_ACCESS=1`, which skips
authentication entirely. Amber then binds `127.0.0.1` only, no matter what
`HOST` says, and says so loudly in the logs and the UI.

## Development

Requires Node 24 or newer (26 recommended, see `.node-version`).

```bash
npm install
npm run dev         # server on :8080, web dev server on :5173
npm test            # shared, server, and web suites
npm run lint        # eslint plus the ASCII dash check
npm run typecheck
npm run build
```

## Architecture

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the source of truth for module
boundaries, the data model, the API surface, and the security rules.

## License

MIT. See [LICENSE](LICENSE).
