# syntax=docker/dockerfile:1

# The compiled JavaScript does not depend on the CPU architecture, so it is
# built once on the native build platform. Emulating this step (e.g. arm64 on
# an amd64 CI runner) is slow and can stall for a long time.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

# Production dependencies contain native modules (argon2, better-sqlite3) and
# are installed for the target platform.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @openstatuspage/server...
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @openstatuspage/server deploy --prod --legacy /out/server

FROM node:22-bookworm-slim
# Memory (docs/architecture.md#memory): a small young generation and a cap on the
# old generation keep an instance below 100 MB; fewer malloc arenas and libuv
# threads keep native memory small. Override NODE_OPTIONS to raise the cap, e.g.
# for large history imports on an admin instance.
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=sqlite:/data/openstatuspage.db \
    WEB_DIST_DIR=/app/web \
    NODE_OPTIONS="--max-semi-space-size=1 --max-old-space-size=96" \
    MALLOC_ARENA_MAX=2 \
    UV_THREADPOOL_SIZE=2
WORKDIR /app
COPY --from=deps /out/server /app/server
COPY --from=build /app/apps/server/dist /app/server/dist
COPY --from=build /app/apps/web/dist /app/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
# Plain bash instead of a second node process (about 40 MB every 30 s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/$PORT && printf 'GET /api/health HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
# --max-opt=2: no TurboFan (Maglev still optimizes hot code). Its compiled code and
# compiler zones cost 10-15 MB per instance, more than a status page gains from it.
# NODE_OPTIONS cannot carry this V8 flag, so it is part of the command.
CMD ["node", "--max-opt=2", "server/dist/index.js"]
