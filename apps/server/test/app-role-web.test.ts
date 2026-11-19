/**
 * Web client per APP_ROLE: a public instance serves public.html and only the
 * files it reaches; the management UI page and its chunks are never served.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, migrateToLatest, type DB } from '../src/db/index.js';
import { adminOnlyFiles } from '../src/web-assets.js';

const MANIFEST = {
  'index.html': {
    file: 'assets/index.js',
    isEntry: true,
    imports: ['_shared.js'],
    dynamicImports: ['src/admin/session.tsx', 'src/help/HelpPage.tsx'],
  },
  'public.html': { file: 'assets/public.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/public/WorldMap.tsx'] },
  '_shared.js': { file: 'assets/shared.js', css: ['assets/shared.css'] },
  'src/admin/session.tsx': { file: 'assets/session.js', imports: ['_shared.js'] },
  'src/help/HelpPage.tsx': { file: 'assets/HelpPage.js', css: ['assets/HelpPage.css'] },
  'src/public/WorldMap.tsx': { file: 'assets/WorldMap.js', assets: ['assets/world.json'] },
};

function makeWebDir(options: { manifest?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'osp-web-role-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>full</title>');
  writeFileSync(join(dir, 'public.html'), '<!doctype html><title>public</title>');
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  for (const chunk of Object.values(MANIFEST)) {
    for (const f of [chunk.file, ...('css' in chunk ? chunk.css : []), ...('assets' in chunk ? chunk.assets : [])]) {
      writeFileSync(join(dir, f), `/* ${f} */`);
      writeFileSync(join(dir, `${f}.map`), '{}');
    }
  }
  if (options.manifest !== false) {
    mkdirSync(join(dir, '.vite'));
    writeFileSync(join(dir, '.vite', 'manifest.json'), JSON.stringify(MANIFEST));
  }
  return dir;
}

async function appFor(role: string, webDir: string): Promise<{ app: FastifyInstance; db: DB }> {
  const config = loadConfig(
    { NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', WEB_DIST_DIR: webDir, APP_ROLE: role },
    { allowSqliteForAnyRole: true },
  );
  const db = await createDb(config);
  await migrateToLatest(db);
  const app = await buildApp({ config, db });
  await app.ready();
  return { app, db };
}

describe('web client per APP_ROLE', () => {
  const webDir = makeWebDir();
  const apps: Record<string, FastifyInstance> = {};
  const dbs: DB[] = [];

  beforeAll(async () => {
    for (const role of ['all', 'admin', 'public', 'worker']) {
      const { app, db } = await appFor(role, webDir);
      apps[role] = app;
      dbs.push(db);
    }
  });
  afterAll(async () => {
    for (const app of Object.values(apps)) await app.close();
    for (const db of dbs) await db.destroy();
    rmSync(webDir, { recursive: true, force: true });
  });

  const get = (role: string, url: string) => apps[role]!.inject({ url });

  it('computes the files only the management UI reaches', () => {
    expect([...adminOnlyFiles(webDir)].sort()).toEqual(
      ['assets/HelpPage.css', 'assets/HelpPage.js', 'assets/index.js', 'assets/session.js', 'index.html'].sort(),
    );
  });

  it('serves the full app and every chunk with all and admin', async () => {
    for (const role of ['all', 'admin']) {
      for (const url of ['/', '/admin', '/admin/login']) {
        const res = await get(role, url);
        expect(res.statusCode, `${role} ${url}`).toBe(200);
        expect(res.body).toContain('<title>full</title>');
      }
      for (const url of ['/assets/session.js', '/assets/HelpPage.css', '/assets/public.js', '/favicon.svg']) {
        expect((await get(role, url)).statusCode, `${role} ${url}`).toBe(200);
      }
    }
  });

  it('serves public.html for client routes on a public instance', async () => {
    for (const url of ['/', '/services/api', '/subscription/manage?id=1', '/administration']) {
      const res = await get('public', url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>public</title>');
    }
  });

  it('answers 404 for the management UI on a public instance', async () => {
    for (const url of ['/admin', '/admin/', '/admin/login', '/admin/users?x=1', '/ADMIN/login', '/%61dmin', '//admin/login']) {
      const res = await get('public', url);
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('<title>');
    }
  });

  it('serves only the files public.html reaches on a public instance', async () => {
    for (const url of ['/assets/public.js', '/assets/shared.js', '/assets/shared.css', '/assets/WorldMap.js', '/assets/world.json', '/assets/public.js.map', '/favicon.svg']) {
      expect((await get('public', url)).statusCode, url).toBe(200);
    }
    for (const url of [
      '/index.html',
      '/assets/index.js',
      '/assets/index.js.map',
      '/assets/session.js',
      '/assets/session.js.map',
      '/assets/HelpPage.js',
      '/assets/HelpPage.css',
      '/assets/%73ession.js',
    ]) {
      expect((await get('public', url)).statusCode, url).toBe(404);
    }
  });

  it('never serves the build manifest', async () => {
    for (const role of ['all', 'admin', 'public']) {
      expect((await get(role, '/.vite/manifest.json')).statusCode, role).toBe(404);
    }
  });

  it('serves no web client on a worker instance', async () => {
    for (const url of ['/', '/admin', '/assets/public.js', '/favicon.svg']) {
      expect((await get('worker', url)).statusCode, url).toBe(404);
    }
    expect((await get('worker', '/api/health')).statusCode).toBe(200);
  });

  it('refuses to start a public instance on a build without the manifest', async () => {
    const dir = makeWebDir({ manifest: false });
    await expect(appFor('public', dir)).rejects.toThrow(/manifest\.json.*rebuild/);
    const { app, db } = await appFor('all', dir);
    expect((await app.inject({ url: '/' })).statusCode).toBe(200);
    await app.close();
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
});

// Checks the real build when it exists (`pnpm -r build` runs before the tests in CI).
const realWebDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const realManifest = join(realWebDir, '.vite/manifest.json');

describe.skipIf(!existsSync(realManifest))('the real web build', () => {
  it('keeps every admin and help module out of public.html', () => {
    const manifest = JSON.parse(readFileSync(realManifest, 'utf8')) as Record<string, { file: string }>;
    const denied = adminOnlyFiles(realWebDir);
    const adminModules = Object.entries(manifest).filter(([key]) => /^src\/(admin|help)\//.test(key));
    expect(adminModules.length).toBeGreaterThan(0);
    for (const [key, chunk] of adminModules) expect(denied.has(chunk.file), key).toBe(true);
    expect(denied.has('index.html')).toBe(true);
    expect(denied.has(manifest['public.html']!.file)).toBe(false);
  });
});
