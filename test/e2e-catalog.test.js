// A phone-sized browser against the Worker with a real country catalog published: titles and posters come from
// the catalog, recommendations are worked out on the phone, and it keeps working with no connection.
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
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('swipeflick.v1') || 'null'));

before(async () => {
  if (skip) return;
  fake = await fakeTmdbServer();
  files = await staticServer((await buildFixtureCatalogs(fake, ['US'])).dir);
  srv = await startServer({ CATALOG_BASE: `${files.base}/catalog`, TMDB_API_KEY: 'k', TMDB_BASE: fake.base });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page = await context.newPage();
  page.on('dialog', (d) => d.accept());
});
after(async () => { await browser?.close(); srv?.stop(); fake?.close(); files?.close(); });

test("titles come from the country's real catalog, with posters and IMDb ratings", { skip }, async () => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: /skip/i }).click();
  await page.locator('#deck .card').first().waitFor();
  const title = await page.locator('#deck .card').first().locator('.card-info h2').first().innerText();
  assert.match(title, /^(Movie|Series) \d+/, 'a TMDB title, not the built-in sample');
  const art = await page.locator('#deck .card').first().locator('.card-page').first().evaluate((el) => el.outerHTML);
  assert.match(art, /image\.tmdb\.org\/t\/p\/w780\/p\d+\.jpg/, 'real poster art');
  await page.locator('[data-tab="profile"]').click();
  assert.match(await page.locator('#catalog-info').innerText(), /Netflix United States: 40 titles/);
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
    assert.match(await page.locator('#deck .card').first().locator('.card-info h2').first().innerText(), /^(Movie|Series) \d+/, 'still the real catalog, from the phone');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('swipeflick.v1')).swipes.length === 1);
    await page.keyboard.press('l');
    await page.getByText("It's a Pick!").waitFor();
    await page.getByRole('button', { name: /keep swiping/i }).click();
    await page.locator('#btn-daily').click();
    await page.locator('#daily-grid .like-card').first().waitFor();
  } finally {
    await context.setOffline(false);
  }
  await page.locator('#daily-back').click();
});

test('titles are matched by name on the phone, and unknown ones are looked up through the server', { skip }, async () => {
  const csv = 'Title,Date\n"Series 3: Season 1: Pilot","9/28/26"\n"Movie 5","9/20/26"\n"Old Movie","8/01/26"\n';
  await page.locator('[data-tab="profile"]').click();
  await page.setInputFiles('#csv-input', { name: 'NetflixViewingHistory.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('#history').getByText(/3 matched to the catalog/).waitFor({ timeout: 15000 });
  const mine = await saved();
  assert.equal(mine.history.groups.length, 3);
  assert.equal(mine.history.groups.find((g) => g.name === 'Old Movie').titleId, 'tmdb-movie-999', 'looked up by name');
  assert.deepEqual(Object.keys(mine.history.titles), ['tmdb-movie-999'], "kept on the phone for titles the catalog doesn't have");
  assert.ok(await page.locator('#taste').getByText('horror').count(), "Old Movie left Netflix but still shapes the phone's taste profile");

  const sent = fake.requests.filter((r) => r.includes('/search/'));
  assert.ok(sent.length > 0 && sent.every((r) => /query=Old(\+|%20)Movie/.test(r)), 'only the title we could not recognise was looked up');
});
