/**
 * Which files of the built web client an instance serves (see role.ts).
 *
 * The web build has two entry pages: index.html (public pages and the management
 * UI) and public.html (public pages only; it never imports the admin routes).
 * Vite writes .vite/manifest.json with the chunk graph of both. An APP_ROLE=public
 * instance serves public.html for every client route and only the files public.html
 * can reach (static and dynamic imports, CSS, assets), so neither the admin page
 * nor any chunk that only the management UI loads is ever served. Files outside
 * the manifest (favicon.svg, ...) are served as usual. The manifest and the
 * server-side rendering bundle (.ssr/) are never served by any role.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppRole } from './role.js';

export const FULL_INDEX = 'index.html';
export const PUBLIC_INDEX = 'public.html';
const MANIFEST = '.vite/manifest.json';

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}
type Manifest = Record<string, ManifestChunk>;

export interface WebAssetPolicy {
  /** Page served for client routes (the SPA fallback). */
  index: string;
  /** Whether a request path (e.g. "/assets/x.js") may be served. */
  allows(pathname: string): boolean;
  /** Whether a client route (e.g. "/admin/users") is served at all. */
  servesRoute(pathname: string): boolean;
}

/** Normalized path as the router sees it (see app.ts): decoded, lower case, single slashes. */
function isAdminRoute(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // keep the raw path
  }
  path = path.toLowerCase().replace(/\/{2,}/g, '/');
  return path === '/admin' || path.startsWith('/admin/');
}

/** Build files only the server reads: the Vite manifest and the server-side rendering bundle. */
const isServerOnlyPath = (pathname: string) =>
  ['/.vite', '/.ssr'].some((dir) => pathname === dir || pathname.startsWith(`${dir}/`));

/** Every file (JS, CSS, assets) one manifest chunk and its imports reach. */
function reachableFiles(manifest: Manifest, entry: string): Set<string> {
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Web build manifest: unknown chunk ${key}`);
    for (const f of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(f);
    for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(next);
  };
  visit(entry);
  return files;
}

function allManifestFiles(manifest: Manifest): Set<string> {
  const files = new Set<string>();
  for (const chunk of Object.values(manifest)) {
    for (const f of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(f);
  }
  return files;
}

/** Files of the build that only index.html (management UI) reaches, relative to the web root. */
export function adminOnlyFiles(webDir: string): Set<string> {
  const manifest = readManifest(webDir);
  const publicFiles = reachableFiles(manifest, PUBLIC_INDEX);
  const out = new Set<string>();
  for (const f of allManifestFiles(manifest)) if (!publicFiles.has(f)) out.add(f);
  out.add(FULL_INDEX);
  return out;
}

function readManifest(webDir: string): Manifest {
  const file = join(webDir, MANIFEST);
  if (!existsSync(file) || !existsSync(join(webDir, PUBLIC_INDEX))) {
    throw new Error(
      `The web build in ${webDir} has no ${MANIFEST} or ${PUBLIC_INDEX}: rebuild the web client ` +
        '(`pnpm build`). APP_ROLE=public needs both to keep the management UI out.',
    );
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (!manifest[PUBLIC_INDEX]?.isEntry) throw new Error(`Web build manifest: ${PUBLIC_INDEX} is not an entry`);
  return manifest;
}

/** Serving rules of the web client for a role (null: the role serves no web client). */
export function webAssetPolicy(role: AppRole, webDir: string): WebAssetPolicy | null {
  if (role === 'worker') return null;
  if (role !== 'public') {
    return {
      index: FULL_INDEX,
      allows: (pathname) => !isServerOnlyPath(pathname),
      servesRoute: () => true,
    };
  }
  const denied = adminOnlyFiles(webDir);
  return {
    index: PUBLIC_INDEX,
    allows: (pathname) => {
      if (isServerOnlyPath(pathname)) return false;
      const file = pathname.replace(/^\/+/, '');
      // Source maps of admin chunks are denied with their chunk.
      return !denied.has(file) && !denied.has(file.replace(/\.map$/, ''));
    },
    servesRoute: (pathname) => !isAdminRoute(pathname),
  };
}
