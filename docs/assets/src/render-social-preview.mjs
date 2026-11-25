// Renders social-preview.html to docs/assets/social-preview.png (1280 x 640).
//   node render-social-preview.mjs
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'social-preview.html')).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(here, '..', 'social-preview.png') });
await browser.close();
console.log('docs/assets/social-preview.png written');
