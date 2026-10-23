import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, rawGet } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

// What a phone sends with each request. The server keeps none of it.
const CSV = 'Title,Date\n"Dark: Season 1: Secrets","9/28/26"\n"Stranger Things: Season 4: Chapter One","9/20/26"\n"The Irishman","8/30/26"\n';
const ask = (route, body = {}) => srv.call('POST', route, { region: 'US', ...body });
const importCsv = async (csv = CSV) => (await srv.call('POST', '/api/history/import', csv)).json;

test('catalog status reports the built-in sample when there is no TMDB key', async () => {
  const { status, json } = await srv.call('GET', '/api/catalog');
  assert.equal(status, 200);
  assert.equal(json.source, 'demo');
  assert.equal(json.count, 100);
  assert.equal(json.defaultRegion, 'US');
  assert.equal(json.job.state, 'idle');
});

test('old server-side endpoints are gone: nothing about a person is stored', async () => {
  for (const [m, p] of [['GET', '/api/state'], ['POST', '/api/swipe'], ['POST', '/api/rewind'], ['POST', '/api/reset'], ['POST', '/api/settings'], ['POST', '/api/netflix/connect'], ['POST', '/api/login']]) {
    assert.equal((await srv.call(m, p, m === 'POST' ? {} : undefined)).status, 404, `${m} ${p}`);
  }
});

test('deck returns unique cards and honours exclude and n', async () => {
  const { json } = await ask('/api/deck', { n: 10 });
  assert.equal(json.cards.length, 10);
  assert.equal(new Set(json.cards.map((c) => c.id)).size, 10);
  const first = json.cards[0].id;
  const again = await ask('/api/deck', { n: 30, exclude: [first] });
  assert.ok(!again.json.cards.some((c) => c.id === first));
  assert.equal((await ask('/api/deck', { n: 999 })).json.cards.length, 30, 'n is capped');
});

test('swiped titles never come back, and swipes steer the deck', async () => {
  const [a, b, c] = (await ask('/api/deck', { n: 3 })).json.cards;
  const swipes = [{ id: a.id, action: 'like' }, { id: b.id, action: 'nope' }, { id: c.id, action: 'super' }];
  const deck = (await ask('/api/deck', { n: 30, swipes })).json.cards.map((x) => x.id);
  assert.ok(![a.id, b.id, c.id].some((id) => deck.includes(id)));

  const p = (await ask('/api/profile', { swipes })).json;
  assert.deepEqual([p.stats.likes, p.stats.supers, p.stats.nopes], [1, 1, 1]);
  assert.ok(p.taste.genres.length > 0);

  const likes = (await ask('/api/likes', { swipes })).json.likes;
  assert.deepEqual(likes.map((l) => l.id), [c.id, a.id], 'newest first, nopes left out');
  assert.equal(likes[0].action, 'super');

  // rewinding is just sending one swipe fewer: the title is available again
  const rewound = (await ask('/api/profile', { swipes: swipes.slice(0, 2) })).json;
  assert.equal(rewound.stats.remaining, p.stats.remaining + 1);
  const cards = (await ask('/api/cards', { ids: [c.id, 'nope-not-real'] })).json.cards;
  assert.deepEqual(cards.map((x) => x.id), [c.id]);
});

test('settings in the request filter the deck', async () => {
  const deck = (await ask('/api/deck', { n: 30, settings: { types: 'series', minRating: 8.5 } })).json.cards;
  assert.ok(deck.length > 0 && deck.every((c) => c.type === 'series' && c.imdbRating >= 8.5));
});

test('hostile or malformed input is ignored, not trusted', async () => {
  const body = {
    region: '../../etc', settings: { types: 'drop table', minRating: 'x', includeWatched: 'yes' },
    swipes: [null, { id: 5, action: 'like' }, { id: 'x', action: 'explode' }, { id: 'imdb-tt3398228', action: 'like' }],
    history: { groups: [{ name: 123 }, null, { name: 'Dark', kind: 'series', views: 'many' }] }, exclude: 'not-a-list',
  };
  const res = await srv.call('POST', '/api/deck', body);
  assert.equal(res.status, 200);
  assert.ok(res.json.cards.length > 0);
  assert.equal((await srv.call('POST', '/api/deck', '{broken')).status, 400);
});

test('CSV import returns show and movie groups and rejects non-Netflix files', async () => {
  const bad = await srv.call('POST', '/api/history/import', 'not,a,netflix file\n1,2,3');
  assert.equal(bad.status, 400);
  const ok = await importCsv();
  assert.equal(ok.entries, 3);
  assert.equal(ok.groups.length, 3);
  assert.deepEqual(ok.groups.map((g) => g.name).sort(), ['Dark', 'Stranger Things', 'The Irishman']);
  assert.equal(ok.groups.find((g) => g.name === 'Dark').kind, 'series');
});

test('history is matched, hidden by default, and comes back as lower-weight rewatches when included', async () => {
  const history = { source: 'csv', entries: 3, groups: (await importCsv()).groups };
  const p = (await ask('/api/profile', { history })).json;
  assert.equal(p.history.matched, 3);
  assert.equal(p.history.titles, 3);
  assert.ok(p.history.recent.every((r) => r.matched));

  const hidden = (await ask('/api/deck', { n: 30, history })).json.cards;
  assert.equal(hidden.filter((c) => c.watched).length, 0);
  const shown = (await ask('/api/deck', { n: 30, history, settings: { includeWatched: true } })).json.cards;
  assert.ok(shown.some((c) => c.watched), 'rewatches appear when included');
  assert.ok(shown.slice(0, 3).filter((c) => c.watched).length < 3, 'but not all at the top');
  const withHistory = (await ask('/api/profile', { history })).json.taste.genres;
  const without = (await ask('/api/profile', {})).json.taste.genres;
  assert.ok(withHistory.length > 0 && without.length === 0, 'history is what builds the taste profile');
});

test('feeling lucky returns one highly rated unswiped title and honours exclude', async () => {
  const first = (await ask('/api/lucky')).json.card;
  assert.ok(first.imdbRating >= 7.5);
  const second = (await ask('/api/lucky', { exclude: [first.id] })).json.card;
  assert.notEqual(second.id, first.id);
});

test("today's picks are stable per date, different on another date, and exclude what you've swiped", async () => {
  const a = (await ask('/api/daily', { date: '2026-10-23' })).json;
  const b = (await ask('/api/daily', { date: '2026-10-23' })).json;
  const c = (await ask('/api/daily', { date: '2026-10-24' })).json;
  assert.equal(a.cards.length, 5);
  assert.deepEqual(a.cards.map((x) => x.id), b.cards.map((x) => x.id));
  assert.notDeepEqual(a.cards.map((x) => x.id), c.cards.map((x) => x.id));
  assert.ok(a.cards.every((x) => x.imdbRating >= 7));
  const swipes = a.cards.slice(0, 2).map((x) => ({ id: x.id, action: 'like' }));
  const after = (await ask('/api/daily', { date: '2026-10-23', swipes })).json.cards.map((x) => x.id);
  assert.ok(!after.includes(swipes[0].id) && !after.includes(swipes[1].id));
});

test('two people get separate recommendations from the same server', async () => {
  const horror = (await ask('/api/deck', { n: 30 })).json.cards.filter((c) => c.genres.includes('Horror')).slice(0, 4);
  const comedy = (await ask('/api/deck', { n: 30 })).json.cards.filter((c) => c.genres.includes('Comedy')).slice(0, 4);
  const likes = (cards) => cards.map((c) => ({ id: c.id, action: 'super' }));
  const [a, b] = await Promise.all([ask('/api/profile', { swipes: likes(horror) }), ask('/api/profile', { swipes: likes(comedy) })]);
  assert.equal(a.json.stats.supers, horror.length);
  assert.notDeepEqual(a.json.taste.genres.slice(0, 2).map((g) => g.name), b.json.taste.genres.slice(0, 2).map((g) => g.name));
  assert.equal((await ask('/api/profile', {})).json.stats.supers, 0, 'a third visitor sees none of it');
});

test('the server keeps no personal data: nothing about a person is written to disk or remembered', async () => {
  const secret = 'Zzyzx Private Documentary';
  const groups = [{ name: secret, kind: 'movie', views: 3, firstWatched: '2026-01-02', lastWatched: '2026-02-03' }];
  await ask('/api/deck', { history: { source: 'csv', entries: 3, groups }, swipes: [{ id: 'imdb-tt3398228', action: 'like' }] });
  await ask('/api/profile', { history: { source: 'csv', entries: 3, groups } });
  await srv.call('POST', '/api/history/import', `Title,Date\n"${secret}","1/2/26"\n"Dark: Season 1: x","9/28/26"\n`);
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const all = files(srv.dir);
  assert.ok(!all.some((f) => /state\.json/.test(f)), 'no per-person state file');
  for (const f of all) assert.ok(!fs.readFileSync(f, 'utf8').includes(secret), `${f} must not contain anyone's history`);
  assert.equal((await srv.call('GET', '/api/catalog')).text.includes(secret), false);
});

test('history lookups do nothing (and cost nothing) without an owner key', async () => {
  const r = await ask('/api/history/resolve', { history: { groups: [{ name: 'Dark', kind: 'series' }] } });
  assert.deepEqual(r.json, { resolved: 0, total: 0 });
});

test('transfer codes carry data across once, then expire', async () => {
  const payload = JSON.stringify({ swipes: [{ id: 'x', action: 'like' }] });
  assert.equal((await srv.call('POST', '/api/transfer', {})).status, 400);
  const { json } = await srv.call('POST', '/api/transfer', { payload });
  assert.match(json.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(json.expiresInMinutes, 10);
  const wrong = await srv.call('POST', '/api/transfer/claim', { code: 'AAAAAAAA' });
  assert.equal(wrong.status, 404);
  const ok = await srv.call('POST', '/api/transfer/claim', { code: json.code.toLowerCase() });
  assert.equal(ok.json.payload, payload, 'case-insensitive');
  assert.equal((await srv.call('POST', '/api/transfer/claim', { code: json.code })).status, 404, 'works once');
});

test('rate limits stop bulk abuse of the expensive endpoints', async () => {
  const s = await startServer();
  try {
    let last;
    for (let i = 0; i < 22; i++) last = await s.call('POST', '/api/history/import', CSV);
    assert.equal(last.status, 429);
    let claim;
    for (let i = 0; i < 12; i++) claim = await s.call('POST', '/api/transfer/claim', { code: `WRONG${i}XX` });
    assert.equal(claim.status, 429, 'guessing transfer codes is throttled');
  } finally { s.stop(); }
});

test('rejects foreign Host headers (DNS rebinding) and path traversal', async () => {
  assert.equal(await rawGet(srv.base, '/api/catalog', 'evil.example'), 403);
  assert.equal(await rawGet(srv.base, '/api/catalog', `localhost:${new URL(srv.base).port}`), 200);
  assert.ok([403, 404].includes((await srv.call('GET', '/..%2fserver.js')).status));
});

test('hosted mode answers on the public hostname; ALLOWED_HOSTS pins it', async () => {
  const open = await startServer({ HOSTED: '1' });
  const pinned = await startServer({ HOSTED: '1', ALLOWED_HOSTS: 'swipeflick.example.com' });
  try {
    assert.equal(await rawGet(open.base, '/', 'swipeflick.example.com'), 200);
    assert.equal(await rawGet(pinned.base, '/', 'swipeflick.example.com'), 200);
    assert.equal(await rawGet(pinned.base, '/', 'evil.example'), 403);
  } finally { open.stop(); pinned.stop(); }
});

test('PWA: manifest, icons and service worker are served correctly', async () => {
  const html = (await srv.call('GET', '/')).text;
  assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  const m = await srv.call('GET', '/manifest.webmanifest');
  assert.match(m.headers.get('content-type'), /manifest\+json/);
  assert.equal(m.json.display, 'standalone');
  assert.ok(m.json.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of m.json.icons) assert.equal((await srv.call('GET', `/${icon.src}`)).status, 200, icon.src);
  const sw = await srv.call('GET', '/sw.js');
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const shell = JSON.parse(sw.text.match(/const SHELL_FILES = (\[.*?\]);/)[1].replace(/'/g, '"'));
  for (const f of shell) assert.equal((await srv.call('GET', f)).status, 200, `${f} must exist or the app can't install`);
  assert.equal((await srv.call('GET', '/')).headers.get('x-content-type-options'), 'nosniff');
});
