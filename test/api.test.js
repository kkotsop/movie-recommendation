import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rawGet } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

const CSV = 'Title,Date\n"Dark: Season 1: Secrets","9/28/26"\n"Stranger Things: Season 4: Chapter One","9/20/26"\n"The Irishman","8/30/26"\n';

test('fresh state uses the demo catalog and has no history', async () => {
  const { status, json } = await srv.call('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(json.catalog.source, 'demo');
  assert.equal(json.history, null);
  assert.equal(json.settings.hasTmdbKey, false);
  assert.equal(json.stats.likes, 0);
});

test('deck returns unique cards and honours exclude', async () => {
  const { json } = await srv.call('GET', '/api/deck?n=10');
  assert.equal(json.cards.length, 10);
  assert.equal(new Set(json.cards.map((c) => c.id)).size, 10);
  const first = json.cards[0].id;
  const again = await srv.call('GET', `/api/deck?n=30&exclude=${first}`);
  assert.ok(!again.json.cards.some((c) => c.id === first));
});

test('swipe, rewind and unswipe update stats and the deck', async () => {
  const { json: { cards } } = await srv.call('GET', '/api/deck?n=3');
  const [a, b, c] = cards;
  assert.equal((await srv.call('POST', '/api/swipe', { id: a.id, action: 'like' })).json.stats.likes, 1);
  assert.equal((await srv.call('POST', '/api/swipe', { id: b.id, action: 'nope' })).json.stats.nopes, 1);
  assert.equal((await srv.call('POST', '/api/swipe', { id: c.id, action: 'super' })).json.stats.supers, 1);

  const deck = (await srv.call('GET', '/api/deck?n=30')).json.cards.map((x) => x.id);
  assert.ok(![a.id, b.id, c.id].some((id) => deck.includes(id)), 'swiped titles never return');

  const rewound = await srv.call('POST', '/api/rewind');
  assert.equal(rewound.json.card.id, c.id);
  assert.equal(rewound.json.action, 'super');
  const state = (await srv.call('GET', '/api/state')).json;
  assert.equal(state.stats.supers, 0, 'rewound swipe no longer counts');
  assert.equal(state.stats.likes, 1);

  await srv.call('POST', '/api/unswipe', { id: a.id });
  const likes = (await srv.call('GET', '/api/likes')).json.likes;
  assert.ok(!likes.some((l) => l.id === a.id));
});

test('bad swipes are rejected and rewinding nothing is a 404', async () => {
  assert.equal((await srv.call('POST', '/api/swipe', { id: 'nope', action: 'like' })).status, 400);
  const { json: { cards } } = await srv.call('GET', '/api/deck?n=1');
  assert.equal((await srv.call('POST', '/api/swipe', { id: cards[0].id, action: 'maybe' })).status, 400);
  await srv.call('POST', '/api/reset', { scope: 'swipes' });
  assert.equal((await srv.call('POST', '/api/rewind')).status, 404);
});

test('CSV import matches titles and hides watched ones until included', async () => {
  const bad = await srv.call('POST', '/api/history/csv', 'not,a,netflix file\n1,2,3');
  assert.equal(bad.status, 400);
  const ok = await srv.call('POST', '/api/history/csv', CSV);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.titles, 3);

  const state = (await srv.call('GET', '/api/state')).json;
  assert.equal(state.history.matched, 3);
  const watchedIds = (await srv.call('GET', '/api/deck?n=30')).json.cards.filter((c) => c.watched);
  assert.equal(watchedIds.length, 0, 'watched hidden by default');

  await srv.call('POST', '/api/settings', { includeWatched: true });
  const withWatched = (await srv.call('GET', '/api/deck?n=30')).json.cards;
  assert.ok(withWatched.some((c) => c.watched && /↻|rewatch/i.test(JSON.stringify(c)) || c.watched), 'rewatches appear when included');
  await srv.call('POST', '/api/settings', { includeWatched: false });
});

test('settings validate input and filter the deck', async () => {
  await srv.call('POST', '/api/settings', { types: 'series', minRating: 8.5, region: 'gr', tmdbKey: undefined });
  const { json } = await srv.call('GET', '/api/state');
  assert.equal(json.settings.types, 'series');
  assert.equal(json.settings.minRating, 8.5);
  assert.equal(json.settings.region, 'US', 'lowercase region ignored');
  const deck = (await srv.call('GET', '/api/deck?n=30')).json.cards;
  assert.ok(deck.every((c) => c.type === 'series' && c.imdbRating >= 8.5));
  await srv.call('POST', '/api/settings', { types: 'both', minRating: 0 });
});

test('feeling lucky returns one highly rated unswiped title and honours exclude', async () => {
  const first = (await srv.call('GET', '/api/lucky')).json.card;
  assert.ok(first.imdbRating >= 7.5);
  const second = (await srv.call('GET', `/api/lucky?exclude=${first.id}`)).json.card;
  assert.notEqual(second.id, first.id);
});

test("today's picks are stable per date and different on another date", async () => {
  const a = (await srv.call('GET', '/api/daily?date=2026-10-23')).json;
  const b = (await srv.call('GET', '/api/daily?date=2026-10-23')).json;
  const c = (await srv.call('GET', '/api/daily?date=2026-10-24')).json;
  assert.equal(a.cards.length, 5);
  assert.deepEqual(a.cards.map((x) => x.id), b.cards.map((x) => x.id));
  assert.notDeepEqual(a.cards.map((x) => x.id), c.cards.map((x) => x.id));
  assert.ok(a.cards.every((x) => x.imdbRating >= 7));
});

test('reset clears swipes, and reset everything also clears history', async () => {
  const { json: { cards } } = await srv.call('GET', '/api/deck?n=1');
  await srv.call('POST', '/api/swipe', { id: cards[0].id, action: 'like' });
  assert.equal((await srv.call('POST', '/api/reset', { scope: 'swipes' })).json.stats.likes, 0);
  assert.ok((await srv.call('GET', '/api/state')).json.history, 'history kept');
  const all = await srv.call('POST', '/api/reset', { scope: 'all' });
  assert.equal(all.json.history, null);
  assert.equal(all.json.onboarded, false);
});

test('rejects foreign Host headers (DNS rebinding) and path traversal', async () => {
  assert.equal(await rawGet(srv.base, '/api/state', 'evil.example'), 403);
  assert.equal(await rawGet(srv.base, '/api/state', `localhost:${new URL(srv.base).port}`), 200);
  const trav = await srv.call('GET', '/..%2fserver.js');
  assert.ok([403, 404].includes(trav.status));
});

test('PWA: manifest, icons and service worker are served correctly', async () => {
  const html = (await srv.call('GET', '/')).text;
  assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);

  const m = await srv.call('GET', '/manifest.webmanifest');
  assert.match(m.headers.get('content-type'), /manifest\+json/);
  assert.equal(m.json.display, 'standalone');
  assert.equal(m.json.start_url, '/');
  assert.ok(m.json.icons.some((i) => i.sizes === '192x192') && m.json.icons.some((i) => i.sizes === '512x512'));
  assert.ok(m.json.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of m.json.icons) assert.equal((await srv.call('GET', `/${icon.src}`)).status, 200, icon.src);
  assert.equal((await srv.call('GET', '/apple-touch-icon.png')).status, 200);

  const sw = await srv.call('GET', '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  // every file the worker precaches must exist, or install() fails and the app is never installable
  const shell = JSON.parse(sw.text.match(/const SHELL_FILES = (\[.*?\]);/)[1].replace(/'/g, '"'));
  for (const f of shell) assert.equal((await srv.call('GET', f)).status, 200, f);
});
