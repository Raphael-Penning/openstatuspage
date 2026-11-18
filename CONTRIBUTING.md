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
management UI.

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
export SECRET_KEY="$(openssl rand -base64 48)" POSTGRES_PASSWORD=dev-only-password
docker compose -f docker/docker-compose.yml -f docker/docker-compose.build.yml up -d --build
```

`docker/docker-compose.yml` alone runs the prebuilt image; the
`docker-compose.build.yml` override replaces it with `openstatuspage:local`
built from `docker/Dockerfile`.

## Guidelines

- Code, comments and docs in English. UI texts go through i18n
  (`apps/web/src/locales/<lang>/*.json`); add every key to all languages.
- Keep the repository free of environment specific data: no real hostnames,
  IPs, credentials or company names. Use `example.com` and fictional data.
- Public API responses must never expose internal monitoring details
  (see [docs/architecture.md](docs/architecture.md#privacy-model)).
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Database changes: add a new migration, never modify an existing one.
