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
- **Paranoid mode.** Never lose history. Pruning and garbage collection are
  disabled and every ref tip that upstream rewrites or deletes is archived under
  `refs/amber/archive/<timestamp>/` before the update lands.
- **Clone modes.** Bare, mirror, shallow, or a full working tree, with Git LFS
  objects fetched alongside.
- **Layered settings.** Configure at the global, forge, account, or repository
  scope. The narrowest scope wins, and the UI shows you which one did.
- **Read-only git remote.** `git clone` straight from your backup.
- **Exports.** Download the source tree or the entire backup directory as zip,
  tar.gz, or 7z.
- **Resilient scheduling.** Persistent per-repo schedules, exponential backoff
  with jitter, and a circuit breaker for network outages. A forge being down is
  the reason Amber exists, not a reason to give up on a repository.

## Self-hosting

Prebuilt images are published to GHCR on every push to main:
`ghcr.io/pmaxhogan/amber:latest`. No need to clone or build anything -
[`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) pulls
the image, mounts a data directory, and includes an optional label-scoped
Watchtower sidecar that keeps the container current automatically.

```bash
curl -fsSLO https://raw.githubusercontent.com/pmaxhogan/amber/main/deploy/docker-compose.example.yml
curl -fsSL https://raw.githubusercontent.com/pmaxhogan/amber/main/.env.example -o .env
# Edit docker-compose.example.yml: point the volume and env_file at your data
# directory and set user: to its owner. Fill in AMBER_SECRET_KEY and the
# Cloudflare Access settings in .env, then:
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
in front of it, and the server verifies the Access JWT on every request.
[`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) is a
starting point for a real deployment.

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
