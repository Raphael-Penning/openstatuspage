import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/feed': { target: apiTarget, changeOrigin: false },
    },
  },
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
});
