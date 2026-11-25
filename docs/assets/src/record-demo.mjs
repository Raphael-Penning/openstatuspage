// Records the README demo (docs/assets/demo.gif) and the static screenshot
// (docs/assets/screenshot.png) from a running instance with demo data.
//
//   BASE_URL=http://localhost:3123 node record-demo.mjs
//
// Needs gifski (https://gif.ski) on the PATH for the GIF. Frames are taken as
// screenshots at a fixed rate while the script clicks through the main flow:
// overview -> ongoing incident -> back -> service with its 90-day history.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const out = join(dirname(fileURLToPath(import.meta.url)), '..');
const FPS = 10;
const VIEW = { width: 960, height: 600 };

const browser = await chromium.launch();

// Static screenshot of the overview (2x for sharp text on HiDPI screens).
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US' });
  await page.goto(`${base}/?lang=en`, { waitUntil: 'networkidle' });
  // From the top down to the end of the first service group, so the
  // overall state, the incident and the 90-day bars are all visible.
  const group = page.getByRole('heading', { name: 'Platform' }).first().locator('xpath=ancestor::section[1]');
  const bottom = await group.evaluate((el) => el.getBoundingClientRect().bottom + scrollY + 32);
  await page.screenshot({ path: join(out, 'screenshot.png'), fullPage: true, clip: { x: 0, y: 0, width: 1280, height: Math.min(bottom, 2400) } });
  await page.close();
}

// GIF frames.
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', bypassCSP: true });
const page = await context.newPage();
// A visible pointer, so the clicks are easy to follow in the GIF.
await page.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    dot.id = 'demo-pointer';
    Object.assign(dot.style, {
      position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', margin: '-11px 0 0 -11px',
      borderRadius: '50%', background: 'rgba(124,108,242,.35)', border: '2px solid rgba(124,108,242,.9)',
      pointerEvents: 'none', zIndex: '2147483647', transition: 'transform .12s', transform: 'translate(var(--x,-50px),var(--y,-50px))',
    });
    document.body.append(dot);
    const pos = sessionStorage.getItem('demo-pointer');
    if (pos) dot.style.cssText += pos;
    addEventListener('mousemove', (e) => {
      const css = `--x:${e.clientX}px;--y:${e.clientY}px`;
      dot.style.setProperty('--x', `${e.clientX}px`);
      dot.style.setProperty('--y', `${e.clientY}px`);
      sessionStorage.setItem('demo-pointer', css);
    });
    addEventListener('mousedown', () => (dot.style.scale = '0.7'));
    addEventListener('mouseup', () => (dot.style.scale = '1'));
  });
});

const frames = [];
let recording = false;
async function recorder() {
  const step = 1000 / FPS;
  let next = performance.now();
  while (recording) {
    const shot = await page.screenshot({ type: 'png' }).catch(() => null);
    const now = performance.now();
    // Keep a constant frame rate: repeat the shot for every tick it covers.
    while (shot && next <= now) {
      frames.push(shot);
      next += step;
    }
    await new Promise((r) => setTimeout(r, Math.max(0, next - performance.now())));
  }
}
const wait = (ms) => page.waitForTimeout(ms);
async function moveTo(locator, steps = 12) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + Math.min(box.width / 2, 160), box.y + box.height / 2, { steps });
}
async function smoothScroll(y, ms) {
  await page.evaluate(([to, dur]) => new Promise((done) => {
    const from = scrollY, t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      scrollTo(0, from + (to - from) * e);
      k < 1 ? requestAnimationFrame(tick) : done();
    };
    requestAnimationFrame(tick);
  }), [y, ms]);
}

await page.goto(`${base}/?lang=en`, { waitUntil: 'networkidle' });
await page.mouse.move(VIEW.width / 2, VIEW.height - 40);
recording = true;
const rec = recorder();

// 1. Overview: overall state, then the services with their 90-day bars.
await wait(1000);
const groups = page.getByRole('heading', { name: 'Platform' }).first();
const groupsY = await groups.evaluate((el) => el.getBoundingClientRect().top + scrollY - 70);
await smoothScroll(groupsY, 1100);
await wait(1100);
await smoothScroll(0, 700);
await wait(300);

// 2. The ongoing incident.
const incident = page.getByRole('link', { name: 'Slow responses from the Public API' }).first();
await moveTo(incident);
await wait(250);
await Promise.all([page.waitForURL(/\/incidents\//), incident.click()]);
await page.waitForLoadState('networkidle');
await wait(1000);
await smoothScroll(280, 700);
await wait(1300);
await smoothScroll(0, 500);

// 3. The affected service and its history.
const service = page.getByRole('link', { name: 'Public API', exact: true }).first();
await moveTo(service);
await wait(250);
await Promise.all([page.waitForURL(/\/services\//), service.click()]);
await page.waitForLoadState('networkidle');
await wait(2200);

recording = false;
await rec;
await browser.close();

// Frames -> GIF.
const dir = mkdtempSync(join(tmpdir(), 'osp-demo-'));
frames.forEach((buf, i) => writeFileSync(join(dir, `f${String(i).padStart(4, '0')}.png`), buf));
const files = frames.map((_, i) => join(dir, `f${String(i).padStart(4, '0')}.png`));
const gif = join(out, 'demo.gif');
execFileSync('gifski', ['--quiet', '--fps', String(FPS), '--quality', '80', '--width', String(VIEW.width), '-o', gif, ...files]);
if (process.env.KEEP_FRAMES) console.log(`frames kept in ${dir}`);
else rmSync(dir, { recursive: true, force: true });
console.log(`${frames.length} frames, ${(frames.length / FPS).toFixed(1)} s, ${(statSync(gif).size / 1e6).toFixed(2)} MB -> ${gif}`);
