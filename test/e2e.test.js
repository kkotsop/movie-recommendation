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
const KEY = 'swipeflix.v1';

/** What this phone has saved: the app keeps everything in the browser, not on the server. */
const saved = (p = page) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY);
const stats = async (p = page) => {
  const swipes = (await saved(p))?.swipes || [];
  const n = (a) => swipes.filter((s) => s.action === a).length;
  return { likes: n('like'), supers: n('super'), later: n('later'), nopes: n('nope'), total: swipes.length };
};
const swipeCount = (p, n) => p.waitForFunction(([k, count]) => JSON.parse(localStorage.getItem(k)).swipes.length === count, [KEY, n]);
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

/** Drags the top card by (dx, dy) pixels with a pointer. */
async function drag(p, dx, dy) {
  const box = await p.locator('#deck .card').first().boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 3;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + dx, y + dy, { steps: 10 });
  await p.mouse.up();
}

test('first visit: the welcome screen offers to add history, says what happens to it, and can be skipped', { skip }, async () => {
  await page.goto(srv.base);
  assert.equal(await page.locator('#welcome-add').innerText(), 'Add my Netflix history');
  assert.match(await page.locator('#welcome-privacy').innerText(), /password is never asked for, seen or stored/i);
  assert.doesNotMatch(await page.locator('#welcome').innerText(), /bookmark|sync from netflix/i, 'no bookmark flow any more');
  await page.locator('#welcome-skip').click();
  await page.locator('#deck .card').first().waitFor();
  assert.ok((await page.locator('#deck .card').count()) >= 2);
  await page.locator('#welcome').waitFor({ state: 'hidden' });
  assert.equal((await saved()).onboarded, true);
});

test('the main screen is uncluttered: three tabs, three action buttons, no key legend, no expand button', { skip }, async () => {
  assert.equal(await page.locator('.tab').count(), 3);
  assert.equal(await page.locator('#actions .act:not([disabled])').count(), 3, 'nope, lucky, like (rewind appears after a swipe)');
  assert.equal(await page.locator('.info-btn, .keys, #btn-filters').count(), 0);
  assert.equal(await page.locator('#deck .card').first().locator('.card-bars span').count(), 2, 'two pages per card');
});

test('a card has two pages: the poster, then description, reason and details together', { skip }, async () => {
  const card = page.locator('#deck .card').first();
  assert.equal(await card.locator('.card-face.on').getAttribute('data-face'), '0');
  const box = await card.boundingBox();
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.4);
  assert.equal(await card.locator('.card-face.on').getAttribute('data-face'), '1');
  const back = await card.locator('.card-back').innerText();
  assert.match(back, /why it's here/i);
  assert.ok((await card.locator('.card-overview').innerText()).length > 20, 'the description is on the same page');
  assert.ok(await card.locator('.card-links a').count() >= 1, 'with the watch link');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.4);
  assert.equal(await card.locator('.card-face.on').getAttribute('data-face'), '0');
});

test('arrow keys like and nope, backspace rewinds', { skip }, async () => {
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#likes-badge') && !document.querySelector('#likes-badge').hidden);
  assert.equal((await stats()).likes, 1);
  await page.keyboard.press('ArrowLeft');
  await swipeCount(page, 2);
  assert.equal((await stats()).nopes, 1);
  await page.keyboard.press('Backspace');
  await swipeCount(page, 1);
  assert.equal((await stats()).nopes, 0);
});

test('swiping down saves a title for later; up marks it must-watch', { skip }, async () => {
  const before = await stats();
  await page.keyboard.press('ArrowDown');
  await swipeCount(page, before.total + 1);
  assert.equal((await stats()).later, before.later + 1);
  assert.match(await page.locator('#toast').innerText(), /saved for later/i);
  await page.keyboard.press('ArrowUp');
  await swipeCount(page, before.total + 2);
  assert.equal((await stats()).supers, before.supers + 1);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await swipeCount(page, before.total);
});

test('dragging: a short drag springs back, right likes, down saves for later, up is must-watch', { skip }, async () => {
  const start = await stats();
  await drag(page, 30, 0);
  await page.waitForTimeout(500);
  assert.equal((await stats()).total, start.total, 'a short drag does not swipe');

  await drag(page, 400, 10);
  await swipeCount(page, start.total + 1);
  assert.equal((await stats()).likes, start.likes + 1, 'a long right drag likes');

  await page.locator('#deck .card').first().waitFor();
  await page.waitForTimeout(450);
  await drag(page, 0, 320);
  await swipeCount(page, start.total + 2);
  assert.equal((await stats()).later, start.later + 1, 'a long drag down saves for later');

  await page.waitForTimeout(450);
  await drag(page, 0, -320);
  await swipeCount(page, start.total + 3);
  assert.equal((await stats()).supers, start.supers + 1, 'a long drag up is must-watch');
});

test('swipes survive a reload because they are stored on the device', { skip }, async () => {
  const before = await stats();
  await page.reload();
  await page.locator('#deck .card').first().waitFor();
  assert.deepEqual(await stats(), before);
});

test("I'm feeling lucky shows a single pick that can be saved", { skip }, async () => {
  await page.keyboard.press('l');
  await page.getByText("Tonight's pick").waitFor();
  assert.match(await page.locator('#match-inner .match-name').innerText(), /\S/);
  const supers = (await stats()).supers;
  await page.getByRole('button', { name: /save to must watch/i }).click();
  await page.waitForTimeout(400);
  assert.equal((await stats()).supers, supers + 1);
  assert.equal(await page.locator('#match').isHidden(), true);
});

test("Today's picks lists five titles and acting on one removes it", { skip }, async () => {
  await page.locator('#btn-daily').click();
  await page.locator('#daily-grid .like-card').first().waitFor();
  assert.equal(await page.locator('#daily-grid .like-card').count(), 5);
  const likesBefore = (await stats()).likes;
  await page.locator('#daily-grid .like-card').first().click();
  await page.locator('#detail [data-d="like"]').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#daily-grid .like-card').count(), 4);
  assert.equal((await stats()).likes, likesBefore + 1);
  await page.locator('#daily-back').click();
});

test('Saved has Liked, Must watch and Later, and a later title can be promoted to a like', { skip }, async () => {
  await page.locator('#deck .card').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  await page.locator('[data-tab="likes"]').click();
  const s = await stats();
  const shown = (n) => page.waitForFunction((c) => document.querySelectorAll('#likes-grid .like-card').length === c, n);
  await shown(s.likes + s.supers);
  const liked = await page.locator('#likes-grid .like-card').count();
  await page.locator('#likes-filter [data-filter="super"]').click();
  await shown(s.supers);
  assert.ok(s.supers >= 1 && s.supers < liked);
  await page.locator('#likes-filter [data-filter="later"]').click();
  await shown(s.later);
  assert.ok(s.later >= 1);
  await page.locator('#likes-grid .like-card').first().click();
  await page.locator('#detail [data-d="like"]').click();
  await page.waitForFunction((n) => document.querySelectorAll('#likes-grid .like-card').length === n, s.later - 1);
  assert.equal((await stats()).likes, s.likes + 1, 'promoted from later to liked');
});

test('Profile holds your settings: show me, watched, other services, rating and country', { skip }, async () => {
  await page.locator('[data-tab="profile"]').click();
  assert.equal(await page.locator('.topbar #btn-filters, #sheet-filters, #profile-sync').count(), 0, 'no separate settings screen, no Netflix sync button');
  assert.match(await page.locator('#view-profile').innerText(), /what you see/i);
  await page.locator('#types [data-types="series"]').click();
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).settings.types === 'series', KEY);
  await page.locator('#types [data-types="both"]').click();
  await page.locator('#include-watched').check();
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).settings.includeWatched === true, KEY);
  await page.locator('#include-watched').uncheck();
  await page.locator('#region').selectOption('GR');
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).settings.region === 'GR', KEY);
  await page.locator('#region').selectOption('US');
  assert.equal(await page.locator('#tmdb-key, #tmdb-save').count(), 0, 'visitors never see a TMDB key field');
});

test('titles from other services need a catalog; until there is one the switch says so and stays off', { skip }, async () => {
  await page.locator('[data-tab="profile"]').click();
  await page.locator('#include-anywhere').check();
  await page.locator('#toast', { hasText: /aren't available yet/i }).waitFor();
  assert.equal(await page.locator('#include-anywhere').isChecked(), false);
  assert.equal((await saved()).settings.anywhere, false);
});

test('adding history walks you through it: four steps, then choose the file', { skip }, async () => {
  await page.locator('[data-tab="profile"]').click();
  assert.equal(await page.locator('#view-profile').getByRole('button', { name: /upload viewing history/i }).count(), 1, 'one way to add history');
  await page.locator('#profile-upload').click();
  const step = () => page.locator('.howto-step:visible h3').innerText();
  assert.match(await step(), /^1\. Open Netflix/);
  assert.equal(await page.locator('#howto-back').isVisible(), false);
  await page.locator('#howto-next').click();
  assert.match(await step(), /^2\. Open Viewing activity/);
  await page.locator('#howto-next').click();
  assert.match(await step(), /^3\. Tap “Download all”/);
  await page.locator('#howto-next').click();
  assert.match(await step(), /^4\. Choose the file here/);
  assert.equal(await page.locator('#howto-next').isVisible(), false);
  assert.equal(await page.locator('.howto-step:visible label[for="csv-input"]').innerText(), 'Choose file');
  assert.match(await page.locator('.howto-skip').innerText(), /already have the file/i);
  await page.locator('#howto-back').click();
  assert.match(await step(), /^3\./);
  await page.locator('#sheet-howto button[data-close]').first().click();
});

test('choosing a CSV reads it on the phone and fills in the profile', { skip }, async () => {
  const csv = 'Title,Date\n"Dark: Season 1: Secrets","9/28/26"\n"Stranger Things: Season 4: Chapter One","9/20/26"\n"The Irishman","8/30/26"\n';
  await page.locator('#profile-upload').click();
  await page.setInputFiles('#csv-input', { name: 'NetflixViewingHistory.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('#toast', { hasText: /Added 3 views across 3 titles/ }).waitFor();
  await page.locator('#history').getByText(/3 found in the catalog/).waitFor();
  assert.equal((await saved()).history.groups.length, 3);
  assert.equal(await page.locator('#sheet-howto').isHidden(), true, 'the walkthrough closes itself');
  assert.match(await page.locator('#profile-upload').innerText(), /replace my viewing history/i);
  await page.setInputFiles('#csv-input', { name: 'junk.csv', mimeType: 'text/csv', buffer: Buffer.from('not,a,netflix file\n1,2,3') });
  await page.locator('#toast', { hasText: /doesn't look like a Netflix/ }).waitFor();
  assert.equal((await saved()).history.groups.length, 3, 'a bad file changes nothing');
});

test('About & credits shows the TMDB logo and attribution, and makes no exception to "your data stays here"', { skip }, async () => {
  await page.locator('[data-tab="profile"]').click();
  assert.match(await page.locator('#storage-note').innerText(), /saved on this device only/i);
  await page.locator('#open-about').click();
  const about = await page.locator('#sheet-about').innerText();
  assert.match(about, /uses the TMDB API but is not endorsed or certified by TMDB/);
  const logo = page.locator('#sheet-about img.tmdb-logo');
  assert.equal(await logo.evaluate((img) => img.complete && img.naturalWidth > 0), true, 'the TMDB logo loads');
  assert.equal(await logo.getAttribute('alt'), 'The Movie Database (TMDB)');
  assert.doesNotMatch(about, /exception|looked up|look up|names of watched titles/i, 'no exception in the disclaimer');
  assert.match(about, /none of it is sent to us/i);
  await page.locator('#sheet-about button[data-close]').first().click();
});

test('the Profile reset buttons are visible, and resetting swipes clears the counters', { skip }, async () => {
  await page.locator('[data-tab="profile"]').click();
  for (const id of ['#reset-swipes', '#reset-all']) {
    assert.ok((await page.locator(id).boundingBox()).height > 30, `${id} must not be squashed to nothing on a phone`);
  }
  await page.locator('#reset-swipes').click();
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).swipes.length === 0, KEY);
  assert.equal((await stats()).total, 0);
  assert.equal((await saved()).history.groups.length, 3, 'your Netflix history stays');
});

test('the page registers a service worker and links a manifest (installable shell)', { skip }, async () => {
  await page.goto(srv.base);
  const ok = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active) && Boolean(document.querySelector('link[rel="manifest"]'));
  });
  assert.equal(ok, true);
});

test('both colour schemes are readable and use one accent colour with no gradients', { skip }, async () => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const look = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const bg = getComputedStyle(document.body).backgroundColor;
      const btn = document.querySelector('.btn') || document.querySelector('.tab.on');
      const gradients = [...document.querySelectorAll('*')].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)
        && !el.matches('.card-shade, .lc-info')).length;
      return { bg, accent: css.getPropertyValue('--accent').trim(), gradients, btn: btn && getComputedStyle(btn).color };
    });
    assert.equal(look.accent, '#E5481F');
    assert.equal(look.gradients, 0, `${scheme}: gradients are only used to keep text readable over posters`);
    assert.notEqual(look.bg, 'rgb(0, 0, 0)');
  }
  await page.emulateMedia({ colorScheme: null });
});

test('two people on the same server have completely separate data', { skip }, async () => {
  const a = await newPhone();
  const b = await newPhone();
  try {
    for (const { p } of [a, b]) {
      await p.goto(srv.base);
      await p.locator('#welcome-skip').click();
      await p.locator('#deck .card').first().waitFor();
    }
    await a.p.keyboard.press('ArrowRight');
    await swipeCount(a.p, 1);
    assert.equal((await stats(a.p)).likes, 1);
    assert.equal((await stats(b.p)).total, 0, "B can't see A's swipes");
    await b.p.reload();
    await b.p.locator('#deck .card').first().waitFor();
    assert.equal((await stats(b.p)).total, 0);
  } finally { await a.ctx.close(); await b.ctx.close(); }
});

test("Move your data: a code carries one device's history and swipes to another", { skip }, async () => {
  const a = await newPhone();
  const b = await newPhone();
  try {
    await a.p.goto(srv.base);
    await a.p.locator('#welcome-skip').click();
    await a.p.locator('#deck .card').first().waitFor();
    await a.p.keyboard.press('ArrowRight');
    await a.p.keyboard.press('ArrowRight');
    await swipeCount(a.p, 2);
    await a.p.locator('[data-tab="profile"]').click();
    await a.p.locator('#open-transfer').click();
    await a.p.locator('#transfer-send').click();
    await a.p.locator('#transfer-code').waitFor();
    const code = (await a.p.locator('#transfer-code').innerText()).trim();
    assert.match(code, /^[A-Z2-9]{8}$/);

    await b.p.goto(srv.base);
    await b.p.locator('#welcome-skip').click();
    await b.p.locator('[data-tab="profile"]').click();
    await b.p.locator('#open-transfer').click();
    await b.p.locator('#transfer-input').fill(code);
    await b.p.locator('#transfer-claim').click();
    await swipeCount(b.p, 2);
    assert.equal((await stats(b.p)).likes, 2);

    await b.p.locator('#open-transfer').click();
    await b.p.locator('#transfer-input').fill(code);
    await b.p.locator('#transfer-claim').click();
    await b.p.locator('#toast', { hasText: /not valid|expired/i }).waitFor();
  } finally { await a.ctx.close(); await b.ctx.close(); }
});
