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
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

/** What this phone has saved: the app keeps everything in the browser, not on the server. */
const saved = (p = page) => p.evaluate(() => JSON.parse(localStorage.getItem('swipeflick.v1') || 'null'));
const stats = async (p = page) => {
  const swipes = (await saved(p))?.swipes || [];
  const n = (a) => swipes.filter((s) => s.action === a).length;
  return { likes: n('like'), supers: n('super'), nopes: n('nope') };
};
const newPhone = async () => {
  const ctx = await browser.newContext(PHONE);
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  return { ctx, p };
};

before(async () => {
  if (skip) return;
  srv = await startServer();
  context = await browser.newContext(PHONE);
  page = await context.newPage();
  page.on('dialog', (d) => d.accept());
});
after(async () => { await browser?.close(); srv?.stop(); });

test('welcome screen can be skipped and the deck appears', { skip }, async () => {
  await page.goto(srv.base);
  assert.match(await page.locator('#welcome-privacy').innerText(), /password is never asked for, seen or stored/i);
  assert.equal(await page.locator('#welcome label[for="csv-input"]').count(), 0, 'no CSV upload on the welcome screen');
  await page.getByRole('button', { name: /skip/i }).click();
  await page.locator('#deck .card').first().waitFor();
  assert.ok((await page.locator('#deck .card').count()) >= 2);
  await page.locator('#welcome').waitFor({ state: 'hidden' });
  assert.equal((await saved()).onboarded, true);
});

test('arrow keys like and nope the top card, backspace rewinds', { skip }, async () => {
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#likes-badge') && !document.querySelector('#likes-badge').hidden);
  assert.equal((await stats()).likes, 1);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('swipeflick.v1')).swipes.length === 2);
  assert.equal((await stats()).nopes, 1);
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('swipeflick.v1')).swipes.length === 1);
  assert.equal((await stats()).nopes, 0);
});

test('swipes survive a reload because they are stored on the device', { skip }, async () => {
  await page.reload();
  await page.locator('#deck .card').first().waitFor();
  assert.equal((await stats()).likes, 1);
  await page.locator('[data-tab="likes"]').click();
  await page.locator('#likes-grid .like-card').first().waitFor();
  assert.equal(await page.locator('#likes-grid .like-card').count(), 1);
  await page.locator('[data-tab="discover"]').click();
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

test("Today's picks lists five titles and swiping one removes it", { skip }, async () => {
  await page.locator('#btn-daily').click();
  await page.locator('#daily-grid .like-card').first().waitFor();
  assert.equal(await page.locator('#daily-grid .like-card').count(), 5);
  const likesBefore = (await stats()).likes;
  await page.locator('#daily-grid .like-card').first().click();
  await page.locator('#detail [data-d="like"]').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#daily-grid .like-card').count(), 4);
  assert.equal((await stats()).likes, likesBefore + 1);
  await page.locator('#daily-back').click();
});

test('Likes tab shows saved titles and the Must watch filter narrows them', { skip }, async () => {
  await page.locator('[data-tab="likes"]').click();
  const expected = (await saved()).swipes.filter((x) => x.action !== 'nope').length;
  await page.waitForFunction((n) => document.querySelectorAll('#likes-grid .like-card').length === n, expected);
  const all = await page.locator('#likes-grid .like-card').count();
  await page.locator('#likes-filter [data-filter="super"]').click();
  const must = await page.locator('#likes-grid .like-card').count();
  const swipes = (await saved()).swipes.map((x) => x.action);
  assert.ok(must >= 1 && must < all, `all=${all} must=${must} swipes=${swipes}`);
});

test('settings sheet filters the deck to series', { skip }, async () => {
  await page.locator('[data-tab="discover"]').click();
  await page.locator('#btn-filters').click();
  await page.locator('#types [data-types="series"]').click();
  await page.locator('#sheet-filters [data-close]').last().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('swipeflick.v1')).settings.types === 'series');
  await page.locator('#deck .card').first().waitFor();
  const types = await page.$$eval('#deck .card .card-info, #deck .card', (els) => els.length);
  assert.ok(types >= 1);
});

test('About & credits carries the TMDB attribution, and there is no TMDB key field', { skip }, async () => {
  await page.locator('[data-tab="profile"]').click();
  assert.equal(await page.locator('#tmdb-key, #tmdb-save').count(), 0, 'visitors never see a TMDB key field');
  assert.match(await page.locator('#storage-note').innerText(), /saved on this device only/i);
  for (const id of ['#reset-swipes', '#reset-all']) {
    assert.ok((await page.locator(id).boundingBox()).height > 30, `${id} must not be squashed to nothing on a phone`);
  }
  await page.locator('#open-about').click();
  assert.match(await page.locator('#sheet-about').innerText(), /uses the TMDB API but is not endorsed or certified by TMDB/);
  await page.locator('#sheet-about [data-close]').last().click();
  await page.locator('[data-tab="discover"]').click();
});

test('reset swipes clears the counters', { skip }, async () => {
  await page.locator('#btn-filters').click();
  await page.locator('#sheet-filters [data-action="reset"]').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('swipeflick.v1')).swipes.length === 0);
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

test('two people on the same server have completely separate data', { skip }, async () => {
  const a = await newPhone();
  const b = await newPhone();
  try {
    for (const { p } of [a, b]) {
      await p.goto(srv.base);
      await p.getByRole('button', { name: /skip/i }).click();
      await p.locator('#deck .card').first().waitFor();
    }
    await a.p.keyboard.press('ArrowRight');
    await a.p.waitForFunction(() => JSON.parse(localStorage.getItem('swipeflick.v1')).swipes.length === 1);
    assert.equal((await stats(a.p)).likes, 1);
    assert.equal((await stats(b.p)).likes, 0, "B can't see A's swipes");
    await b.p.reload();
    await b.p.locator('#deck .card').first().waitFor();
    assert.equal((await stats(b.p)).likes, 0);
  } finally { await a.ctx.close(); await b.ctx.close(); }
});

test("Move your data: a code carries one device's history and swipes to another", { skip }, async () => {
  const a = await newPhone();
  const b = await newPhone();
  try {
    await a.p.goto(srv.base);
    await a.p.getByRole('button', { name: /skip/i }).click();
    await a.p.locator('#deck .card').first().waitFor();
    await a.p.keyboard.press('ArrowRight');
    await a.p.keyboard.press('ArrowRight');
    await a.p.waitForFunction(() => JSON.parse(localStorage.getItem('swipeflick.v1')).swipes.length === 2);
    await a.p.locator('[data-tab="profile"]').click();
    await a.p.locator('#open-transfer').click();
    await a.p.locator('#transfer-send').click();
    await a.p.locator('#transfer-code').waitFor();
    const code = (await a.p.locator('#transfer-code').innerText()).trim();
    assert.match(code, /^[A-Z2-9]{8}$/);

    await b.p.goto(srv.base);
    await b.p.getByRole('button', { name: /skip/i }).click();
    await b.p.locator('[data-tab="profile"]').click();
    await b.p.locator('#open-transfer').click();
    await b.p.locator('#transfer-input').fill(code);
    await b.p.locator('#transfer-claim').click();
    await b.p.waitForFunction(() => JSON.parse(localStorage.getItem('swipeflick.v1')).swipes.length === 2);
    assert.equal((await stats(b.p)).likes, 2);

    await b.p.locator('#open-transfer').click();
    await b.p.locator('#transfer-input').fill(code);
    await b.p.locator('#transfer-claim').click();
    await b.p.locator('#toast', { hasText: /not valid|expired/i }).waitFor();
  } finally { await a.ctx.close(); await b.ctx.close(); }
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

test('phone flow: save the bookmark, run it on Netflix, land back with history stored on the phone', { skip }, async () => {
  const hosted = await startServer({ HOSTED: '1' });
  const { ctx, p } = await newPhone();
  try {
    await p.goto(hosted.base);
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
    await p.locator('#toast', { hasText: /Imported 4 titles/ }).waitFor();
    assert.equal(new URL(p.url()).hash, '', 'the data is removed from the address bar');
    const mine = await saved(p);
    assert.equal(mine.history.entries, 4);
    assert.equal(mine.history.groups.length, 4);
    assert.equal(mine.history.source, 'bookmark');
    await p.locator('[data-tab="profile"]').click();
    await p.locator('#history').getByText(/4 matched to the catalog/).waitFor();
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
