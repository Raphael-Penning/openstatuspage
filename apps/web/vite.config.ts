import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { worldMapSvg } from './tools/world-map.ts';

const apiTarget = process.env.API_URL ?? 'http://localhost:3000';
const require = createRequire(import.meta.url);

/**
 * The server-side rendering bundle only needs renderToString. react-dom/server
 * also bundles the streaming renderer (about 300 kB of source V8 keeps in memory
 * on every public instance); the legacy build has renderToString alone.
 */
const renderToStringOnly = resolve(
  dirname(require.resolve('react-dom/package.json')),
  'cjs/react-dom-server-legacy.node.production.js',
);

/**
 * V8 keeps a module's source in memory, as UTF-16 when it has a single
 * non-ASCII character (twice the size). The minified SSR bundle only has them
 * in string literals (translations), where \uXXXX escapes mean the same.
 */
const asciiOnly: Plugin = {
  name: 'osp-ascii-only',
  // After minification, which would turn escapes back into characters.
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === 'chunk') {
        chunk.code = chunk.code.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      }
    }
  },
};

/**
 * /world-map.svg (tools/world-map.ts): written next to the pages by the client
 * build and served by the dev server. Not part of any chunk, so every role that
 * serves the public pages serves it.
 */
const WORLD_MAP = 'world-map.svg';
function worldMap(): Plugin {
  let svg: string | undefined;
  const source = () => (svg ??= worldMapSvg());
  return {
    name: 'osp-world-map',
    configureServer(server) {
      server.middlewares.use(`/${WORLD_MAP}`, (_req, res) => {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.end(source());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: WORLD_MAP, source: source() });
    },
  };
}

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react(), tailwindcss(), ...(isSsrBuild ? [asciiOnly] : [worldMap()])],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/feed': { target: apiTarget, changeOrigin: false },
    },
  },
  ...(isSsrBuild
    ? {
        // `vite build --ssr src/entry-server.tsx --outDir dist/.ssr` (see package.json):
        // one self-contained, minified ES module the server imports lazily. The
        // production image has no node_modules for the web client, so every
        // dependency is bundled.
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        resolve: { alias: [{ find: /^react-dom\/server$/, replacement: renderToStringOnly }] },
        ssr: { noExternal: true, target: 'node' as const },
        build: {
          emptyOutDir: true,
          minify: true,
          sourcemap: false,
          copyPublicDir: false,
          rollupOptions: {
            // .mjs: the image has no package.json next to the bundle that says "module".
            output: { entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
          },
        },
      }
    : {
        build: {
          outDir: 'dist',
          sourcemap: true,
          // The server reads .vite/manifest.json to tell the files of public.html from
          // those only the management UI loads (APP_ROLE=public serves only the former).
          manifest: true,
          rollupOptions: {
            input: {
              index: resolve(import.meta.dirname, 'index.html'),
              public: resolve(import.meta.dirname, 'public.html'),
            },
          },
        },
      }),
}));
