// Takes the three README screenshots from the running app (the built-in sample, so no network is needed).
// Usage: node scripts/make-screenshots.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../test/helpers.js';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const srv = await startServer();
let browser;
for (const channel of ['chrome', 'msedge', undefined]) {
  try { browser = await chromium.launch({ channel }); break; } catch {}
}
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto(srv.base);
await page.locator('#welcome-skip').click();
await page.locator('#deck .card').first().waitFor();
await page.evaluate(() => localStorage.setItem('swipeflix.coach', '1'));
await page.locator('#coach').evaluate((el) => (el.hidden = true));
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(DOCS, 'swipe.png') });

const box = await page.locator('#deck .card').first().boundingBox();
await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.4);
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(DOCS, 'details.png') });

await page.locator('[data-tab="profile"]').click();
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(DOCS, 'profile.png') });
await browser.close();
srv.stop();
setTimeout(() => process.exit(0), 500);
