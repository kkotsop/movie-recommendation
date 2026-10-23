// A phone-sized browser against the Worker with real country and worldwide catalogs published: titles and posters come
// from the catalogs, recommendations are worked out on the phone, stand-up and concerts show up, and it works offline.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { fakeTmdbServer, buildFixtureCatalogs, staticServer } from './fixtures.js';

let browser;
try {
  const { chromium } = await import('playwright');
  for (const channel of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch({ channel }); break; } catch {}
  }
} catch {}
const skip = browser ? false : 'no browser available (install Chrome or run `npx playwright install chromium`)';

let fake, files, srv, context, page;
const KEY = 'swipeflix.v1';
const saved = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY);
const topTitle = () => page.locator('#deck .card').first().locator('.card-info h2').first().innerText();

before(async () => {
  if (skip) return;
  fake = await fakeTmdbServer();
  files = await staticServer((await buildFixtureCatalogs(fake, ['US'])).dir);
  srv = await startServer({ CATALOG_BASE: `${files.base}/catalog` });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page = await context.newPage();
  page.on('dialog', (d) => d.accept());
});
after(async () => { await browser?.close(); srv?.stop(); fake?.close(); files?.close(); });

test("titles come from the country's real catalog, with real posters and IMDb ratings", { skip }, async () => {
  await page.goto(srv.base);
  await page.locator('#welcome-skip').click();
  await page.locator('#deck .card').first().waitFor();
  assert.match(await topTitle(), /^(Movie|Series|Stand-up|Concert) \d+/, 'a TMDB title, not the built-in sample');
  const art = await page.locator('#deck .card').first().locator('.card-page').first().evaluate((el) => el.outerHTML);
  assert.match(art, /image\.tmdb\.org\/t\/p\/w780\/p\d+\.jpg/, 'real poster art');
  assert.match(await page.locator('#deck .card').first().locator('.rating').first().innerText(), /IMDb\s*\d\.\d/);
  await page.locator('[data-tab="profile"]').click();
  assert.match(await page.locator('#catalog-info').innerText(), /Netflix United States: 50 titles/);
  await page.locator('[data-tab="discover"]').click();
});

test('swiping and recommendations work with no connection once the app has been used', { skip }, async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now the service worker is in charge and caches the catalog
  await page.locator('#deck .card').first().waitFor();
  await page.waitForTimeout(500);
  await context.setOffline(true);
  try {
    await page.reload();
    await page.locator('#deck .card').first().waitFor();
    assert.match(await topTitle(), /^(Movie|Series|Stand-up|Concert) \d+/, 'still the real catalog, from the phone');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).swipes.length === 1, KEY);
    await page.keyboard.press('l');
    await page.getByText("Tonight's pick").waitFor();
    await page.getByRole('button', { name: /keep swiping/i }).click();
    await page.locator('#btn-daily').click();
    await page.locator('#daily-grid .like-card').first().waitFor();
  } finally {
    await context.setOffline(false);
  }
  await page.locator('#daily-back').click();
});

test('someone who watches stand-up gets stand-up recommended', { skip }, async () => {
  const csv = 'Title,Date\n"Stand-up 1","9/28/26"\n"Stand-up 2","9/20/26"\n"Stand-up 3","8/30/26"\n';
  await page.locator('[data-tab="profile"]').click();
  await page.locator('#profile-upload').click();
  await page.setInputFiles('#csv-input', { name: 'NetflixViewingHistory.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('#history').getByText(/3 found in the catalog/).waitFor();
  const mine = await saved();
  assert.equal(mine.history.groups.length, 3);
  assert.equal(mine.history.source, 'csv');
  assert.equal(JSON.stringify(mine).includes('titleId'), false, 'nothing about the lookup is stored');

  await page.locator('[data-tab="discover"]').click();
  await page.locator('#deck .card').first().waitFor();
  const kinds = [];
  for (let i = 0; i < 5; i++) {
    const top = page.locator('#deck .card:not(.fly)').first(); // a swiped card stays on screen for a moment while it flies away
    kinds.push(await top.locator('.chip.format').count() ? await top.locator('.chip.format').first().innerText() : 'other');
    await page.keyboard.press('ArrowDown'); // "later" only moves on: saying nope to each title would itself teach the app to avoid them
    await page.waitForTimeout(250);
  }
  // The deck is a weighted random draw, so this asks for "some" rather than a number; test/engine.test.js checks the ranking with a fixed random source.
  assert.ok(kinds.includes('Stand-up'), `stand-up among the first five titles: ${kinds}`);
  assert.ok((await page.locator('#taste').innerText()).length > 0);
});

test('titles from other services can be switched on, and are marked as not on Netflix', { skip }, async () => {
  await page.locator('[data-tab="profile"]').click();
  await page.locator('#include-anywhere').check();
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).settings.anywhere === true, KEY);
  assert.equal(await page.locator('#include-anywhere').isChecked(), true, 'the worldwide catalog was available, so it stays on');
  assert.match(await page.locator('#catalog-info').innerText(), /Netflix United States: 50 titles/, 'the Netflix count ignores titles from elsewhere');
  await page.locator('[data-tab="discover"]').click();
  await page.locator('#deck .card').first().waitFor();
  let found = null;
  for (let i = 0; i < 90 && !found; i++) {
    const card = page.locator('#deck .card').first();
    if (await card.locator('.chip.elsewhere').count()) { found = await card.locator('.card-info h2').first().innerText(); break; }
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(120);
  }
  assert.match(found || '', /^Worldwide \d+|^Stand-up|^Concert|^Movie/, 'a title that is not on Netflix turned up');
  const card = page.locator('#deck .card').first();
  assert.ok(await card.locator('.chip.elsewhere').count(), 'with the Not on Netflix mark');
  const box = await card.boundingBox();
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.4);
  const link = card.locator('.card-links a').first();
  assert.match(await link.innerText(), /where to watch/i, 'Netflix is not offered for it');
  assert.match(await link.getAttribute('href'), /justwatch\.com\/us\/search/);
});
