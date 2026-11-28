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
then resolves the token's `email` claim to an identity: the one admin
(`AMBER_ADMIN_EMAIL`), or a user the Access policy admits. Anyone else is refused
with 403, and a policy Amber cannot read fails closed (503) rather than open.

Two documented exceptions: `GET /healthz` is unauthenticated so container health
checks work, and `/git/*` uses HTTP basic auth instead of the JWT (see the
read-only git remote below).

Amber fails closed in both directions. It refuses to start when the Cloudflare
Access variables are missing, and any per-request verification failure returns
401 rather than falling through.

### Users, permissions and ownership

Amber can be shared with a small number of trusted-but-limited people. The
admin (`AMBER_ADMIN_EMAIL`) holds every permission and cannot be locked out by
a policy edit or a Cloudflare API failure. Everyone else is a user exactly while
their email is an explicit entry in one reusable Cloudflare Access policy, which
Amber reads with a token scoped to "Access: Apps and Policies Read" only
(`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ACCESS_POLICY_ID`). Removing an email from
the policy removes that person's web and git access within about a minute.
`exclude` rules are honoured and other rule types are ignored, which fails
closed: someone admitted only by a domain or group rule is refused.

- **Per-route authorization.** Every `/api` route declares what it needs (any
  user, the admin, or one named permission) and a hook enforces it; a test fails
  when a route lacks a declaration. Object-level checks (visibility, ownership)
  run in the handler.
- **Visibility.** Every repository has one owner. Other users see it only when
  it is public on its forge and they hold `view_others_public`, or it is private
  and they hold `view_others_private`; unknown is treated as private. A
  repository a caller cannot see answers 404, exactly like one that does not
  exist, on every surface: lists and totals (filtered in SQL), detail, runs,
  browse, export, git clone, live events and push notifications, the last two
  re-checked at send time.
- **Credentials are per user.** A forge account belongs to the user who created
  it and is only ever used for repositories that user owns; no one's token
  fetches on behalf of someone else, and the admin cannot edit another user's
  account. Using accounts needs the `import_private` permission.
- **New hosts.** Only the admin, or a user with `manage_forges`, can introduce a
  new host. See "Outbound requests" below for what a restricted forge may reach.
- **Storage caps.** Each non-admin user has a cap (a per-user value, else a
  global default). At the cap new repositories are refused and existing ones
  keep syncing.

### The insecure escape hatch

`INSECURE_ALLOW_PUBLIC_ACCESS=1` skips authentication entirely and exists for
local development only. Every request is then the admin; for tests,
`INSECURE_USER_EMAILS` plus an `X-Amber-Insecure-User` header lets a request act
as one of those listed users, which can only ever lower its privilege. When it is set, Amber binds `127.0.0.1` only regardless
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

The git remote is off by default (the admin has the switch), and while disabled
every `/git/*` route returns 404. When enabled it serves smart HTTP v2 for `git
upload-pack` only. `git-receive-pack` is never spawned anywhere in the codebase,
so the remote is read-only by construction rather than by a permission check;
requests for it get a 403, after the same authentication as everything else under
`/git`, so an anonymous caller gets the 401 challenge and nothing more.

Credentials are per user. Each person with the `git` permission creates their
own: a random 10 character username (never derived from their email or an id) and
an autogenerated 32 character password from `crypto.randomBytes`. User-supplied
passwords are not accepted. The password is shown once on rotate and stored only
as a scrypt hash (N=2^15, r=8, p=1), compared with `timingSafeEqual`, with
per-IP failure throttling; an unknown username still costs a full hash so response
time does not reveal which usernames exist. After authentication the same
access policy check as the web applies, then the repository must be one the user
can view, or the answer is the same 404 as an unknown one. A credential stops
working when the user leaves the policy (its hash is deleted) and when `git` is
taken away from them. The admin can revoke anyone's password.

### Outbound requests

Fetching user-supplied URLs is Amber's entire purpose, so outbound requests are
inherently arbitrary and Amber is not an SSRF-proof system. What it does do:
restrict transports to http and https via `GIT_ALLOW_PROTOCOL`, refuse
post-initial redirects on git fetches, and keep provider API clients from
following redirects off their original host.

With several users, who may introduce a new host is an access decision. Only the
admin or a user with `manage_forges` can add a forge. A forge is RESTRICTED
unless the admin explicitly allows private networks on it: a restricted forge
must be plain `https` on 443 or `http` on 80, cannot be an IP literal, and every
request to it resolves the host, refuses unless every answer is a public address
(loopback, private, link-local, CGNAT, unique-local, multicast and IPv4-mapped
forms are all refused) and pins the connection to the address it validated, so a
name that changes its answer afterwards (DNS rebinding) cannot redirect a
request. Run Amber on an isolated network and do not put services that trust
requests by source address next to it.

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
  compose file labels the container for a host-wide, label-enable Watchtower
  (run one per host; the file shows how) that picks up a new `:latest` within a
  couple of minutes of publish.
- **Leave the git remote disabled unless you use it,** and have people rotate
  their password if it has ever been shared or logged. If you do enable it, give
  its path its own proxy rule so git clients reach basic auth instead of an SSO
  redirect.
- **Share with the fewest people and the fewest permissions.** Everyone you add
  to the Access policy is trusted with fetching URLs from your network
  position; keep `manage_forges`, `import_private` and `modify_others` for people
  you would give the keys to, scope `CF_API_TOKEN` to "Access: Apps and Policies
  Read" only, and set a storage cap that fits your disk.
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
