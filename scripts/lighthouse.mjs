#!/usr/bin/env node
/**
 * Runs Lighthouse against the public pages of a running instance and prints the
 * scores per page and form factor, plus every audit that did not pass.
 *
 *   CHROME_PATH=/path/to/chrome node scripts/lighthouse.mjs --base-url http://localhost:3000
 *
 * Options:
 *   --base-url <url>     instance to test (default http://localhost:3000)
 *   --preset <p>         mobile, desktop or both (default both)
 *   --pages <a,b,…>      paths to test; default: overview, services, the first
 *                        service, history, the first incident (from the sitemaps)
 *                        and subscribe
 *   --out <dir>          directory for the JSON reports (default: a new temp dir)
 *   --lighthouse <ver>   Lighthouse version run through npx (default 13.6.0)
 *
 * Nothing is installed into the repository: Lighthouse runs through npx and the
 * browser comes from CHROME_PATH (for example Chrome for Testing or
 * chrome-headless-shell from `npx @puppeteer/browsers install`). Exit code 1
 * when a category is below 100 or an audit of the agentic browsing category fails.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    preset: { type: 'string', default: 'both' },
    pages: { type: 'string' },
    out: { type: 'string' },
    lighthouse: { type: 'string', default: '13.6.0' },
  },
});

const chromePath = process.env.CHROME_PATH;
if (!chromePath) {
  console.error('Set CHROME_PATH to a Chrome or chrome-headless-shell binary.');
  process.exit(2);
}
const base = values['base-url'].replace(/\/+$/, '');
const presets = values.preset === 'both' ? ['mobile', 'desktop'] : [values.preset];
const out = values.out ?? mkdtempSync(join(tmpdir(), 'osp-lighthouse-'));
mkdirSync(out, { recursive: true });

/** First <loc> of a sitemap file that matches a path prefix. */
async function firstLoc(file, prefix) {
  const res = await fetch(`${base}/${file}`);
  if (!res.ok) return undefined;
  const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  return locs.find((p) => p.startsWith(prefix));
}

async function defaultPages() {
  const pages = ['/', '/services'];
  const service = await firstLoc('sitemap-services-1.xml', '/services/');
  if (service) pages.push(service);
  pages.push('/history');
  const incident = await firstLoc('sitemap-incidents-1.xml', '/incidents/');
  if (incident) pages.push(incident);
  pages.push('/subscribe');
  return pages;
}

const pages = values.pages ? values.pages.split(',').map((p) => p.trim()) : await defaultPages();
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing'];

function run(path, preset) {
  const name = `${preset}${path.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '') || '-overview'}`;
  const file = join(out, `${name}.json`);
  const args = [
    '--yes',
    `lighthouse@${values.lighthouse}`,
    `${base}${path}`,
    '--quiet',
    '--output=json',
    `--output-path=${file}`,
    '--chrome-flags=--headless=new --no-first-run --no-default-browser-check',
  ];
  if (preset === 'desktop') args.push('--preset=desktop');
  const result = spawnSync('npx', args, { stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
  if (result.status !== 0) throw new Error(`Lighthouse failed for ${path} (${preset})`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const rows = [];
const failures = [];
for (const preset of presets) {
  for (const path of pages) {
    const report = run(path, preset);
    const row = { page: path, preset };
    for (const id of CATEGORIES) {
      const category = report.categories[id];
      if (!category) continue;
      row[id] = category.score === null ? '-' : Math.round(category.score * 100);
      for (const ref of category.auditRefs) {
        const audit = report.audits[ref.id];
        const mode = audit.scoreDisplayMode;
        if (mode === 'notApplicable' || mode === 'manual' || mode === 'informative') continue;
        if (audit.score !== null && audit.score < 1 && (ref.weight > 0 || id === 'agentic-browsing')) {
          failures.push(`${preset} ${path} [${id}] ${ref.id}: ${audit.displayValue ?? audit.title}`);
        }
      }
    }
    rows.push(row);
  }
}

console.table(rows);
if (failures.length) {
  console.log('\nAudits below full score:');
  for (const f of [...new Set(failures)]) console.log(`  ${f}`);
}
console.log(`\nReports: ${out}`);
const below = rows.some((r) => CATEGORIES.some((c) => typeof r[c] === 'number' && r[c] < 100));
const agentic = failures.some((f) => f.includes('[agentic-browsing]'));
process.exit(below || agentic ? 1 : 0);
