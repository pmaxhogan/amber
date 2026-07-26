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
- `e2e/` - Playwright smoke suite against the built Docker image.

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
