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

## Guidelines

- Code, comments and docs in English. UI texts go through i18n
  (`apps/web/src/locales/<lang>/*.json`); add every key to all languages.
- Keep the repository free of environment specific data: no real hostnames,
  IPs, credentials or company names. Use `example.com` and fictional data.
- Public API responses must never expose internal monitoring details
  (see [docs/architecture.md](docs/architecture.md#privacy-model)).
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Database changes: add a new migration, never modify an existing one.
