# Amber

Self-hosted git backup service. **Read `docs/ARCHITECTURE.md` first** - it is the
locked spec for module boundaries, the data model, the API surface, and the
security rules. Deviating from it requires a note in the commit message and a
matching doc update.

## Commands

```bash
npm install
npm run dev              # server (:8080) and web dev server (:5173)
npm test                 # vitest across shared, server, web
npm run test:coverage    # plus v8 coverage into coverage/
npm run coverage:ratchet # fail if coverage dropped more than 0.5 points
npm run lint             # eslint plus scripts/check-ascii.mjs
npm run lint:fix
npm run typecheck        # tsc for shared/server/e2e, vue-tsc for web
npm run build            # shared -> server -> web
```

`shared` must be built before `server` and `web` can resolve its types.
`npm run build` and `npm run typecheck` already do that in order.

## Layout

- `shared/` - zod schemas, API types, the settings registry, the import URL
  parser. Pure logic, no IO, used by both the server and the web app.
- `server/` - Fastify 5 API, node:sqlite data layer, sync engine, git remote.
- `web/` - Vue 3 + Vite + PrimeVue SPA.
- `e2e/` - Playwright smoke suite: UI flows against the built server, plus a
  separate check of the built Docker image from inside the container.

## Dependency pins

- **PrimeVue stays on 4.x, `@primeuix/themes` on 2.x.** PrimeVue 5 switched to
  the commercial PrimeUI license model: every deployment, free Community tier
  included, needs a registered key and renders an "Invalid PrimeUI License"
  banner without one. Amber is public and clone-and-deploy, so there is no key
  to embed. 4.x is MIT. `.github/dependabot.yml` ignores both majors; do not
  bump them past 4.x/2.x unless PrimeVue relicenses.
- **TypeScript stays on 6.x**, not 7.x - typescript-eslint's peer range caps it.
  See the `//typescript` note in the root `package.json`.

## Commit messages

**Conventional Commits, always**: `type(scope): summary`.

- Types in use: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`,
  `ci`, `perf`. Scope is the area touched (`sync`, `web`, `api`, `gitremote`,
  `e2e`, `coverage`, ...) and is optional when a change is genuinely global.
- Summary is lower case, imperative, and no trailing period.
- The body explains WHY, not what the diff already shows. Wrap at 72 columns.
- A change that deviates from `docs/ARCHITECTURE.md` says so in the body and
  updates the doc in the same commit.

## Style rules

- **TypeScript, ESM only.** Relative imports carry a `.ts` extension
  (`rewriteRelativeImportExtensions` rewrites them on build); Node's type
  stripping does not resolve `.js` back to `.ts`.
- **pino only, never `console.*`** in `server/` or `shared/`. Use child loggers
  per module: `log.child({ mod: "sync" })`. ESLint enforces this. The web app
  may use `console.error` or `console.warn` in dev-only guards.
- **No em dashes or en dashes anywhere.** Not in code, comments, docs, YAML,
  commit messages, or UI copy. Use an ASCII `-`. `npm run lint` fails on them.
- **Prettier**: semicolons, double quotes, 2-space indent, 100 columns.
- **LF line endings everywhere.** `.gitattributes` sets `* text=auto eol=lf` and
  the repo has `core.autocrlf=false`.
- Every migration is append-only. Never edit one that has already shipped.
- Credentials never enter git argv, stored remote URLs, logs, API responses, or
  error messages.

## This repo is public

Never commit secrets. `.env` files are gitignored; `.env.example` documents the
variables with empty values.
