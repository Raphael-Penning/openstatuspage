# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm --filter @openstatuspage/server deploy --prod --legacy /out/server

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=sqlite:/data/openstatuspage.db \
    WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /app/apps/server/dist /app/server/dist
COPY --from=build /app/apps/web/dist /app/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
