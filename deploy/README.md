# Deploying Amber

Runbook for the TrueNAS plus Cloudflare setup. This is a stub; the deployment
pass fills in the exact commands and screenshots.

## Overview

```
Internet -> Cloudflare Access (SSO) -> Cloudflare Tunnel -> TrueNAS -> amber:8080
```

Amber has no login of its own. Cloudflare Access authenticates, and the server
independently verifies the Access JWT on every request, so a leaked tunnel
hostname is not enough to reach the API.

## 1. Dataset

Create `/mnt/alpha/apps/amber`, owned by the `apps` user (uid 568). Amber
creates `backups/`, `state/`, and `logs/` inside it on first boot.

## 2. Environment file

Put `.env` at `/mnt/alpha/apps/amber/.env` with only these keys:

- `PORT`
- `AMBER_SECRET_KEY` (`openssl rand -hex 32`, 64 hex characters)
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`
- `CF_ACCESS_ALLOWED_EMAILS`
- `PUBLIC_ORIGIN`
- `LOG_LEVEL`

See `.env.example` in the repository root for what each one does. Back up
`AMBER_SECRET_KEY` somewhere safe: without it, stored account credentials are
unrecoverable.

## 3. Compose

`deploy/docker-compose.nas.yml` runs the app plus a label-scoped Watchtower
sidecar that pulls `ghcr.io/pmaxhogan/amber:latest` within about two minutes of
a publish. The app runs as `568:568`, so no root is needed.

## 4. Cloudflare

1. Tunnel: add the public hostname `amber.maxhogan.dev` pointing at the
   TrueNAS service URL.
2. Access application "Amber" on `amber.maxhogan.dev`: Google IdP only, instant
   auth, policy allowing just the intended email.
3. A second Access application on `amber.maxhogan.dev/git` with a Bypass
   Everyone policy. Without this, git clients hit the SSO page instead of the
   HTTP basic auth that the read-only remote expects.

## 5. Verify

- `https://amber.maxhogan.dev/healthz` responds `{"ok":true,...}`.
- The UI loads and does not show the insecure-mode banner.
- Enable the git remote in the UI, then `git clone` a backup using the
  generated password.
- Confirm a push to that clone is rejected.

## TODO

- Exact `midclt` invocation for the TrueNAS custom app.
- Restore drill: bring a backup back from a `gitdir` export.
