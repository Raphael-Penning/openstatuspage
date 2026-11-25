# README media

Sources of the images in `docs/assets/`:

| File | Made by |
| --- | --- |
| `demo.gif` | `record-demo.mjs` (about 11 s, 960 px wide, under 5 MB) |
| `screenshot.png` | `record-demo.mjs` (overview down to the first service group, 1280 px wide at 2x) |
| `social-preview.png` | `social-preview.html`, rendered by `render-social-preview.mjs` (1280 x 640) |

This folder is not part of the pnpm workspace. It has its own `package.json`
with a pinned Playwright, and the GIF needs [gifski](https://gif.ski)
(`brew install gifski`).

## Social preview

Edit `social-preview.html` (text, colours, logo) and render it:

```bash
cd docs/assets/src
npm install
npx playwright install chromium
node render-social-preview.mjs
```

Upload `docs/assets/social-preview.png` in the repository settings on GitHub
(*Settings → General → Social preview*).

## Demo GIF and screenshot

1. Build the app and start it on a throw-away SQLite database with the demo
   data (`pnpm db:seed` prints the demo webhook source id and its ingest token
   once):

   ```bash
   pnpm install && pnpm build
   export NODE_ENV=production PORT=3123 BASE_URL=http://localhost:3123
   export DATABASE_URL=sqlite:/tmp/osp-demo.db SECRET_KEY="$(openssl rand -base64 48)"
   export ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD="$(openssl rand -hex 12)"
   pnpm db:seed
   pnpm start
   ```

2. In a second shell with the same variables, add the live state (two checks
   with problems, an ongoing incident with an update):

   ```bash
   SOURCE_ID=… INGEST_TOKEN=… node docs/assets/src/demo-data.mjs
   ```

3. Record:

   ```bash
   cd docs/assets/src
   npm install
   npx playwright install chromium
   BASE_URL=http://localhost:3123 node record-demo.mjs
   ```

   `KEEP_FRAMES=1` keeps the PNG frames for a closer look.

The demo data is fictional (Example Corp, example.com); no real accounts or
data are used.
