# Contributing

## Requirements

- Node.js 22+
- pnpm 10 (`corepack enable`)

## Development

```bash
pnpm install
cp .env.example .env            # optional, loaded automatically; defaults work for development
pnpm db:seed                    # optional: fictional demo data
pnpm --filter @openstatuspage/server create-user admin@example.com 'a-long-password' admin
pnpm dev                        # API on :3000, web on :5173 (proxies /api)
```

Open http://localhost:5173 for the status page and http://localhost:5173/admin for the
management UI. The Vite dev server renders everything in the browser (with hot
reload); the server-side rendering of the public pages runs in the production
build only. To check it, build and start that:

```bash
pnpm build
pnpm start                      # http://localhost:3000: public pages rendered on the server
curl -s http://localhost:3000/ | head -c 2000
```

Server-side rendering and hydration are covered by `apps/web/src/ssr.test.tsx`
(every public page hydrates without warnings) and
`apps/server/test/ssr-pages.test.ts` (status codes, head, caching, fallback).
See [docs/architecture.md](docs/architecture.md#server-side-rendering).

Every public page must also work **without JavaScript** (check it in the
production build with JavaScript turned off): a new control is a link or a form
whose state is in the URL, a menu or an expander is a `<details>`, a submit
button only browsers without JavaScript need goes into `<NoScript>`, and a form
posts to a form handler in `apps/server/src/forms/` (never to `/api`).
`apps/server/test/nojs-pages.test.ts` fails on a button, field or tab stop that
needs a script. See [docs/architecture.md](docs/architecture.md#without-javascript).

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Docker image

CI builds the image on every pull request (amd64 only, nothing is pushed) and
publishes it to the GitHub Container Registry from `main` and release tags, see
[docs/releasing.md](docs/releasing.md). To build and run it from your checkout:

```bash
docker build -f docker/Dockerfile -t openstatuspage:local .

# or the full stack with PostgreSQL, built from the checkout:
cd deploy/compose
cp .env.example .env
printf 'SECRET_KEY=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 48)" "$(openssl rand -hex 16)" >> .env
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

`deploy/compose/compose.yaml` alone runs the prebuilt image (it is also the file
operators download from the release assets); the `compose.build.yaml` override
replaces it with `openstatuspage:local` built from `docker/Dockerfile`. The
`.env` in `deploy/compose` is ignored by git. For local testing set
`BASE_URL=http://localhost:3000` and an empty `TRUST_PROXY` in it. The project
is named `openstatuspage` (volumes `openstatuspage_data`, `openstatuspage_pg`);
pass `-p <name>` to keep a test stack apart from another instance on the same
machine. `docker compose down -v` removes the stack including its data.

## Guidelines

- Code, comments and docs in English. UI texts go through i18n
  (`apps/web/src/locales/<lang>/*.json`); add every key to all languages.
- Keep the repository free of environment specific data: no real hostnames,
  IPs, credentials or company names. Use `example.com` and fictional data.
- Public API responses must never expose internal monitoring details
  (see [docs/architecture.md](docs/architecture.md#privacy-model)).
- The public page and the emails target WCAG 2.2 AA
  ([docs/accessibility.md](docs/accessibility.md)): new public pages go into
  the axe-core test (`apps/web/src/public/a11y`), new colors into the tokens in
  `styles.css` (checked by `tokens.test.ts`), and status is never shown by
  color alone.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Database changes: add a new migration, never modify an existing one.
