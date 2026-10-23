// Drives the real UI in a phone-sized browser. Skipped when no Chrome/Edge/Chromium is available.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let browser;
try {
  const { chromium } = await import('playwright');
  for (const channel of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch({ channel }); break; } catch {}
  }
} catch {}
const skip = browser ? false : 'no browser available (install Chrome or run `npx playwright install chromium`)';

let srv, context, page;
const stats = async () => (await srv.call('GET', '/api/state')).json.stats;

before(async () => {
  if (skip) return;
  srv = await startServer();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  page = await context.newPage();
  page.on('dialog', (d) => d.accept());
});
after(async () => { await browser?.close(); srv?.stop(); });

test('welcome screen can be skipped and the deck appears', { skip }, async () => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: /skip/i }).click();
  await page.locator('#deck .card').first().waitFor();
  assert.ok((await page.locator('#deck .card').count()) >= 2);
  await page.locator('#welcome').waitFor({ state: 'hidden' });
});

test('arrow keys like and nope the top card, backspace rewinds', { skip }, async () => {
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#likes-badge') && !document.querySelector('#likes-badge').hidden);
  assert.equal((await stats()).likes, 1);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  assert.equal((await stats()).nopes, 1);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  assert.equal((await stats()).nopes, 0);
});

test('dragging a card past the threshold swipes it, a short drag springs back', { skip }, async () => {
  const before = await stats();
  const box = await page.locator('#deck .card').first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 3;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  assert.deepEqual(await stats(), before, 'a short drag does not swipe');

  const box2 = await page.locator('#deck .card').first().boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 3);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width * 0.95, box2.y + box2.height / 3, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  assert.equal((await stats()).likes, before.likes + 1, 'a long right drag likes');
});

test("I'm feeling lucky shows a single pick that can be saved", { skip }, async () => {
  await page.keyboard.press('l');
  await page.getByText("It's a Pick!").waitFor();
  assert.match(await page.locator('#match-inner .match-name').innerText(), /\S/);
  const supers = (await stats()).supers;
  await page.getByRole('button', { name: /save to must watch/i }).click();
  await page.waitForTimeout(500);
  assert.equal((await stats()).supers, supers + 1);
  assert.equal(await page.locator('#match').isHidden(), true);
});

test("Today's picks tab lists five titles and swiping one removes it", { skip }, async () => {
  await page.locator('#btn-daily').click();
  await page.locator('#daily-grid .like-card').first().waitFor();
  assert.equal(await page.locator('#daily-grid .like-card').count(), 5);
  const name = await page.locator('#daily-grid .lc-title').first().innerText();
  await page.locator('#daily-grid .like-card').first().click();
  await page.locator('#detail [data-d="like"]').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#daily-grid .like-card').count(), 4);
  const likes = (await srv.call('GET', '/api/likes')).json.likes.map((l) => l.title);
  assert.ok(likes.includes(name));
});

test('Likes tab shows saved titles and the Must watch filter narrows them', { skip }, async () => {
  await page.locator('[data-tab="likes"]').click();
  await page.locator('#likes-grid .like-card').first().waitFor();
  const all = await page.locator('#likes-grid .like-card').count();
  await page.locator('#likes-filter [data-filter="super"]').click();
  const must = await page.locator('#likes-grid .like-card').count();
  assert.ok(must >= 1 && must < all);
});

test('settings sheet filters the deck to series', { skip }, async () => {
  await page.locator('[data-tab="discover"]').click();
  await page.locator('#btn-filters').click();
  await page.locator('#types [data-types="series"]').click();
  await page.locator('#sheet-filters [data-close]').last().click();
  await page.waitForTimeout(800);
  const deck = (await srv.call('GET', '/api/state')).json.settings.types;
  assert.equal(deck, 'series');
});

test('About & credits carries the TMDB attribution', { skip }, async () => {
  await page.locator('[data-tab="profile"]').click();
  await page.locator('#open-about').click();
  assert.match(await page.locator('#sheet-about').innerText(), /uses the TMDB API but is not endorsed or certified by TMDB/);
  await page.locator('#sheet-about [data-close]').last().click();
  await page.locator('[data-tab="discover"]').click();
});

test('reset swipes clears the counters', { skip }, async () => {
  await page.locator('#btn-filters').click();
  await page.locator('#sheet-filters [data-action="reset"]').click();
  await page.waitForTimeout(700);
  const s = await stats();
  assert.deepEqual([s.likes, s.supers, s.nopes], [0, 0, 0]);
});

test('page registers a service worker and links a manifest (installable shell)', { skip }, async () => {
  await page.goto(srv.base);
  const ok = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active) && Boolean(document.querySelector('link[rel="manifest"]'));
  });
  assert.equal(ok, true);
});

// A stand-in for netflix.com/viewingactivity: a few rows plus a "Show More" button that reveals the rest.
const FAKE_NETFLIX = `<!doctype html><title>Viewing activity</title>
<ul id="list">
  <li class="retableRow"><div class="date">9/28/26</div><div class="title"><a>Dark: Season 1: Secrets</a></div></li>
  <li class="retableRow"><div class="date">9/20/26</div><div class="title"><a>Stranger Things: Season 4: Chapter One</a></div></li>
</ul>
<button id="more">Show More</button>
<script>
  document.getElementById('more').onclick = function () {
    document.getElementById('list').insertAdjacentHTML('beforeend',
      '<li class="retableRow"><div class="date">8/30/26</div><div class="title"><a>The Irishman</a></div></li>' +
      '<li class="retableRow"><div class="date">8/15/26</div><div class="title"><a>Bird Box</a></div></li>');
    this.remove();
  };
</script>`;

test('phone flow: unlock, save the bookmark, run it on Netflix, land back with history imported', { skip }, async () => {
  const CODE = 'phone-code';
  const hosted = await startServer({ ACCESS_TOKEN: CODE });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  try {
    await p.goto(hosted.base);
    await p.locator('#lock-code').fill('wrong');
    await p.getByRole('button', { name: 'Unlock' }).click();
    await p.locator('#lock-error').waitFor();
    await p.locator('#lock-code').fill(CODE);
    await p.getByRole('button', { name: 'Unlock' }).click();

    await p.locator('#welcome').waitFor({ state: 'visible' });
    assert.match(await p.locator('#welcome-netflix').innerText(), /sync from netflix/i);
    assert.match(await p.locator('#welcome-privacy').innerText(), /password is never asked for, seen or stored/i);
    await p.locator('#welcome-netflix').click();
    assert.match(await p.locator('#sheet-sync .privacy-note').innerText(), /don't store your Netflix login/i);
    const bookmark = await p.locator('#sync-code').inputValue();
    assert.match(bookmark, /^javascript:/);
    assert.ok(!/[\r\n]/.test(bookmark), 'a bookmark has to survive being one line');
    assert.ok(!bookmark.includes('%'), 'percent signs would be decoded when the bookmark runs');

    await ctx.route('https://www.netflix.com/**', (route) => route.fulfill({ contentType: 'text/html', body: FAKE_NETFLIX }));
    await p.goto('https://www.netflix.com/viewingactivity');
    await p.evaluate((code) => { location.href = code; }, bookmark);

    await p.waitForURL(`${hosted.base}/**`);
    await p.locator('#toast', { hasText: /Imported 4 views across 4 titles/ }).waitFor();
    assert.equal(new URL(p.url()).hash, '', 'the data is removed from the address bar');
    const state = await p.evaluate(() => fetch('/api/state').then((r) => r.json()));
    assert.equal(state.history.entries, 4);
    assert.equal(state.history.matched, 4);
    assert.equal(state.history.source, 'csv');
  } finally {
    await ctx.close();
    hosted.stop();
  }
});

test('the bookmark asks you to open Netflix first when run elsewhere', { skip }, async () => {
  const { bookmarkletFor } = await import('../public/netflix-export.js');
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const seen = [];
  p.on('dialog', (d) => { seen.push(d.message()); d.accept(); });
  try {
    await p.goto('data:text/html,<title>not netflix</title>');
    await p.evaluate((code) => { location.href = code; }, bookmarkletFor('http://localhost:1'));
    await p.waitForTimeout(300);
    assert.match(seen[0] || '', /Open netflix\.com/);
  } finally { await ctx.close(); }
});
