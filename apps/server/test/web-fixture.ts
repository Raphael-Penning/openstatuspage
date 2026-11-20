/**
 * A web build for tests: public.html and index.html as Vite writes them, the
 * manifest, empty assets, and the server-side rendering entry from the web
 * sources (apps/web/src/entry-server.tsx), so no web build is needed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import type { RenderModule } from '../src/ssr/pages.js';

/** The web client's render entry, from source (a URL, so the server's typecheck does not compile the web sources). */
const ENTRY = new URL('../../web/src/entry-server.tsx', import.meta.url).href;
export const renderFromSource = () => import(/* @vite-ignore */ ENTRY) as Promise<RenderModule>;

export const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <meta name="description" content="Template description" />
    <meta name="color-scheme" content="light dark" />
    <title>Status</title>
    <script type="module" crossorigin src="/assets/public.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/shared.js">
    <link rel="stylesheet" crossorigin href="/assets/shared.css">
  </head>
  <body>
    <div id="root"></div>
    <!-- Public pages only -->
  </body>
</html>
`;

const MANIFEST = {
  'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'] },
  'public.html': { file: 'assets/public.js', isEntry: true, imports: ['_shared.js'] },
  '_shared.js': { file: 'assets/shared.js', css: ['assets/shared.css'] },
};

/** Creates the web directory; returns it with a function that removes it. */
export function createWebDir(): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'osp-web-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, '.vite'));
  mkdirSync(join(dir, '.ssr'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>management</title><div id="root"></div>');
  writeFileSync(join(dir, 'public.html'), TEMPLATE);
  writeFileSync(join(dir, '.vite', 'manifest.json'), JSON.stringify(MANIFEST));
  for (const f of ['assets/index.js', 'assets/public.js', 'assets/shared.js', 'assets/shared.css', '.ssr/entry-server.mjs']) {
    writeFileSync(join(dir, f), '');
  }
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The rendered app markup of a page (the content of <div id="root">). */
export const rootOf = (res: LightMyRequestResponse) =>
  /<div id="root">([\s\S]*)<\/div><script type="application\/json"/.exec(res.body)?.[1] ?? '';

/** Opening tags of the elements `tag` in `html`, as attribute maps (a tiny parser for assertions). */
export function elements(html: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? '');
    out.push(attrs);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
}

/** The markup of the first <form> whose action is `action` (with its content). */
export function formHtml(html: string, action: string): string | null {
  for (const m of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const attrs = elements(m[0], 'form')[0]!;
    if (attrs.action === action) return m[0];
  }
  return null;
}
