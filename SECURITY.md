# Security Policy

## Supported versions

Amber is pre-1.0 and has no tagged releases yet. Only the current `main` branch
and the `ghcr.io/pmaxhogan/amber:latest` image built from it are supported.
Fixes land on `main` and ship in the next `latest` image; there are no backports
to older `sha-*` tags. Once releases begin, only the newest one will be
supported.

## Reporting a vulnerability

Report privately through GitHub, not in a public issue: go to the
[Security tab](https://github.com/pmaxhogan/amber/security) of
`pmaxhogan/amber` and choose **Report a vulnerability**. That opens a private
advisory visible only to you and the maintainer.

Useful details: affected version or image tag, configuration (in particular
whether an authenticating proxy is in front and whether the read-only git remote
is enabled), reproduction steps, and impact.

Amber is maintained by one person in their spare time. There is no bug bounty
and no paid support. Response is best effort: expect an acknowledgement within
about a week, and a fix timeline that depends on severity. Please allow a
reasonable window for a fix before disclosing publicly.

## Security model

The authoritative description lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); this is a summary of the
properties Amber tries to hold.

### Authentication

Amber has no login of its own. It is designed to sit behind an authenticating
proxy and to verify that proxy's assertion itself, so a leaked container port is
not a leaked instance. The reference setup is a Cloudflare Tunnel with a
Cloudflare Access application in front of it; Amber verifies the Access JWT
(signature against the team JWKS, issuer, audience, expiry) on every request and
additionally requires the token's `email` claim to appear in
`CF_ACCESS_ALLOWED_EMAILS`.

Two documented exceptions: `GET /healthz` is unauthenticated so container health
checks work, and `/git/*` uses HTTP basic auth instead of the JWT (see the
read-only git remote below).

Amber fails closed in both directions. It refuses to start when the Cloudflare
Access variables are missing, and any per-request verification failure returns
401 rather than falling through.

### The insecure escape hatch

`INSECURE_ALLOW_PUBLIC_ACCESS=1` skips authentication entirely and exists for
local development only. When it is set, Amber binds `127.0.0.1` only regardless
of `HOST`, logs a warning banner at startup and every ten minutes, reports
`insecureMode: true` from `GET /api/status`, and the web UI renders a permanent
undismissable red banner. Loopback traffic is never treated as authenticated in
any other configuration.

### Credentials at rest

Forge account credentials (personal access tokens, app passwords) are encrypted
with AES-256-GCM under `AMBER_SECRET_KEY`, a 64 hex character key supplied
through the environment and never written to the database. Startup fails fast if
the key is missing or malformed while encrypted secrets exist. Secrets are
write-only over the API: responses carry `hasSecret: boolean` and never the
value. No secret appears in logs, error messages, git argv, or stored remote
URLs.

### Credential misdirection

A compromised web UI, or an operator tricked into pasting the wrong URL, must
not be able to walk a stored token to an attacker-controlled host. Amber
enforces that structurally:

- `forges.protocol`, `forges.host`, and `forges.port` are immutable after
  create. Changing a host means creating a new forge, which has no credentials.
- `accounts.forge_id` is immutable, so a credential can never be moved to a
  different forge. Secret updates only overwrite in place.
- `repos.forge_id` is immutable, so a repo cannot be re-pointed at another forge
  in order to inherit that forge's credentials.
- Git fetches run with `http.followRedirects=initial`, so post-initial redirects
  are never followed.
- The askpass helper is pinned to the expected host and returns nothing when
  git's prompt names any other host. This is the backstop if a malicious forge
  tries to redirect a credentialed request somewhere else.

### Git subprocess execution

All git and git-lfs invocations go through one hardened wrapper. It uses
argument arrays with no shell, so nothing repo-controlled is ever parsed as a
flag or a command. Credentials never appear in argv or in stored remote URLs;
authentication happens through a one-shot `GIT_ASKPASS` helper reading
per-invocation environment variables, with `GIT_TERMINAL_PROMPT=0` always set.

The environment is scrubbed and pinned: `GIT_CONFIG_NOSYSTEM=1`, `HOME` pointed
at an empty Amber-owned directory so no ambient git config applies,
`GIT_ALLOW_PROTOCOL=https:http` as a transport allowlist,
`transfer.credentialsInUrl=die`, and `GIT_LFS_SKIP_SMUDGE=1`. Every process gets
a hard kill timer and is tracked for graceful shutdown, and output is captured
into bounded buffers.

Malicious repository content is handled by never executing it rather than by
trying to validate it: hooks are disabled (`core.hooksPath` points at an empty
directory), smudge and clean filters are off, submodule recursion is disabled,
and file content is read through git plumbing rather than by walking the working
tree. Note that `fetch.fsckObjects` is deliberately not enabled by default,
because it rejects real-world repositories with historical object quirks.

### Read-only git remote

The git remote is off by default, and while disabled every `/git/*` route
returns 404. When enabled it serves smart HTTP v2 for `git upload-pack` only.
`git-receive-pack` is never spawned anywhere in the codebase, so the remote is
read-only by construction rather than by a permission check; requests for it get
a 403.

Access is HTTP basic auth with an autogenerated 32 character password from
`crypto.randomBytes`. User-supplied passwords are not accepted. The password is
shown once on enable or rotate and stored only as a scrypt hash
(N=2^15, r=8, p=1), compared with `timingSafeEqual`, with per-IP failure
throttling.

### Outbound requests

Fetching user-supplied URLs is Amber's entire purpose, so outbound requests are
inherently arbitrary and Amber is not an SSRF-proof system. What it does do:
restrict transports to http and https via `GIT_ALLOW_PROTOCOL`, refuse
post-initial redirects on git fetches, and keep provider API clients from
following redirects off their original host. Run Amber on an isolated network
and do not put services that trust requests by source address next to it.

## Hardening recommendations for self-hosters

- **Put an authenticating proxy in front of it, always.** Amber assumes one.
  `deploy/docker-compose.example.yml` is the reference deployment, and Cloudflare
  Access is the setup the JWT middleware is written against. Never set
  `INSECURE_ALLOW_PUBLIC_ACCESS` on anything reachable from a network.
- **Run the container as a non-root user.** Nothing in the image needs root. Set
  `user:` to the uid:gid that owns the data directory on the host.
- **Give Amber a dedicated data directory** owned by that uid, not shared with
  other services, with permissions that keep other local users out. It holds the
  encrypted database, the logs, and every backed-up repository.
- **Protect `AMBER_SECRET_KEY` and the env file.** Keep the env file readable
  only by the deploying user. Losing the key makes every stored account secret
  unrecoverable; leaking it exposes them all.
- **Scope forge tokens as narrowly as the forge allows.** Amber only ever reads.
  On GitHub that is a fine-grained token with `Contents: Read-only` (plus the
  account permission `Starring: Read-only` if starred-repo sync is used); GitLab
  `read_repository`; Bitbucket and Gitea repository read.
- **Keep the image updated.** Amber is pre-1.0 and moves fast. The example
  compose file includes an optional label-scoped Watchtower sidecar that picks up
  a new `:latest` within a couple of minutes of publish.
- **Leave the git remote disabled unless you use it,** and rotate its password if
  it has ever been shared or logged. If you do enable it, give its path its own
  proxy rule so git clients reach basic auth instead of an SSO redirect.
- **Enable paranoid mode on anything you truly cannot lose.** It is a durability
  feature rather than a security one, but it is the setting that makes an
  upstream force-push or branch deletion non-destructive.

## Out of scope

The following will be closed without a fix:

- Anything that requires `INSECURE_ALLOW_PUBLIC_ACCESS=1`. That flag documents
  itself as removing authentication, binds loopback only, and warns continuously.
  Running it exposed is a misconfiguration, not a vulnerability.
- Vulnerabilities in upstream `git`, `git-lfs`, or other system packages in the
  base image. Report those to their maintainers. If Amber is using such a tool in
  a way that makes an upstream issue materially worse, that part is in scope, so
  say so.
- Resource exhaustion from importing very large or very numerous repositories,
  or from an upstream repository growing without bound. Amber will use the disk,
  bandwidth, and time that the repositories you point it at require. Concurrency
  limits and timeouts exist to keep it well behaved, not to defend an operator
  against their own import list.
- Missing defense in depth that has no path to impact behind a correctly
  configured authenticating proxy, such as the absence of CSRF tokens on an API
  that requires a proxy-issued JWT.
- Findings from automated scanners with no demonstrated exploit path.
