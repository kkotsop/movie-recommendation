// The Cloudflare Worker, run locally with Wrangler: catalog files, history lookups, transfer codes, static app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.js';
import { fakeTmdbServer, buildFixtureCatalogs, staticServer } from './fixtures.js';

let fake, files, srv, noKey;
before(async () => {
  fake = await fakeTmdbServer();
  const { dir } = await buildFixtureCatalogs(fake, ['US']);
  files = await staticServer(dir);
  [srv, noKey] = await Promise.all([
    startServer({ CATALOG_BASE: `${files.base}/catalog`, TMDB_API_KEY: 'secret-owner-key', TMDB_BASE: fake.base }),
    startServer({ CATALOG_BASE: `${files.base}/catalog` }),
  ]);
});
after(() => { srv?.stop(); noKey?.stop(); fake?.close(); files?.close(); });

const searches = () => fake.requests.filter((r) => r.includes('/search/')).length;

test("a country's catalog is passed through from where the scheduled job published it", async () => {
  const res = await srv.call('GET', '/api/catalog/US');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
  assert.equal(res.json.region, 'US');
  assert.equal(res.json.titles.length, 40);
  assert.ok(files.hits.includes('/catalog/US.json.gz'));
  assert.equal((await srv.call('GET', '/api/catalog/us')).status, 200, 'lowercase is fine');
});

test('countries without a built catalog, or with a bad code, are a plain 404 (the app falls back to the sample)', async () => {
  for (const p of ['/api/catalog/GR', '/api/catalog/USA', '/api/catalog/1', '/api/catalog/', '/api/catalog/..%2f..']) {
    assert.equal((await srv.call('GET', p)).status, 404, p);
  }
  const unreachable = await startServer({ CATALOG_BASE: 'http://127.0.0.1:9/none' });
  try { assert.equal((await unreachable.call('GET', '/api/catalog/US')).status, 404, 'an unreachable source is also "not built"'); } finally { unreachable.stop(); }
});

test('the old per-person endpoints are gone: the phone does its own recommending', async () => {
  for (const [m, p] of [['POST', '/api/deck'], ['POST', '/api/profile'], ['POST', '/api/lucky'], ['POST', '/api/daily'], ['POST', '/api/likes'],
    ['POST', '/api/cards'], ['POST', '/api/history/import'], ['GET', '/api/state'], ['POST', '/api/swipe'], ['POST', '/api/login']]) {
    assert.equal((await srv.call(m, p, m === 'POST' ? {} : undefined)).status, 404, `${m} ${p}`);
  }
});

test('unrecognised watched titles are looked up by name, once, and the answer is shared', async () => {
  const groups = [{ name: 'Series 3', kind: 'series' }, { name: 'Old Movie', kind: 'movie' }, { name: 'Nothing Matches This', kind: 'movie' }];
  const first = (await srv.call('POST', '/api/history/resolve', { groups })).json;
  assert.deepEqual(first.ids, ['tmdb-tv-203', 'tmdb-movie-999', null]);
  assert.deepEqual(Object.keys(first.titles).sort(), ['tmdb-movie-999', 'tmdb-tv-203']);
  const old = first.titles['tmdb-movie-999'];
  assert.deepEqual([old.title, old.genres, old.onNetflix], ['Old Movie', ['Horror'], false]);
  assert.ok(!('overview' in old) && !('poster' in old), 'only what the recommender needs is sent to the phone');
  const spent = searches();
  assert.ok(spent >= 3);

  const second = (await srv.call('POST', '/api/history/resolve', { groups })).json;
  assert.deepEqual(second.ids, first.ids);
  assert.equal(searches(), spent, 'the second person triggers no TMDB searches at all');
});

test('a lookup batch is small, because the free plan allows 50 outbound calls per request', async () => {
  const groups = Array.from({ length: 30 }, (_, i) => ({ name: `Unknown ${i}`, kind: 'movie' }));
  const r = (await srv.call('POST', '/api/history/resolve', { groups })).json;
  assert.equal(r.ids.length, 8);
  assert.equal((await srv.call('POST', '/api/history/resolve', { groups: 'nope' })).json.ids.length, 0);
  assert.equal((await srv.call('POST', '/api/history/resolve', '{broken')).status, 400);
});

test('without an owner key lookups quietly do nothing', async () => {
  const r = await noKey.call('POST', '/api/history/resolve', { groups: [{ name: 'Series 3', kind: 'series' }, { name: 'Roma', kind: 'movie' }] });
  assert.deepEqual(r.json, { ids: [null, null], titles: {} });
});

test('a lookup sends only a name and kind to the server: dates and viewing counts are dropped, never stored', async () => {
  const groups = [{ name: 'Zzyzx Private Documentary', kind: 'movie', views: 77, firstWatched: '2026-01-02', lastWatched: '2026-02-03', titleId: 'x' }];
  await srv.call('POST', '/api/history/resolve', { groups, swipes: [{ id: 'imdb-tt1', action: 'like' }], history: { source: 'csv' } });
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const all = files(srv.dir).filter((f) => fs.statSync(f).size > 0);
  assert.ok(all.length > 0);
  for (const f of all) {
    const bytes = fs.readFileSync(f);
    assert.ok(!bytes.includes('2026-01-02') && !bytes.includes('2026-02-03'), `${f} must not contain viewing dates`);
    assert.ok(!bytes.includes('imdb-tt1'), `${f} must not contain swipes`);
  }
});

test('transfer codes carry data across once, then expire', async () => {
  const payload = JSON.stringify({ swipes: [{ id: 'x', action: 'like' }] });
  assert.equal((await srv.call('POST', '/api/transfer', {})).status, 400);
  const { json } = await srv.call('POST', '/api/transfer', { payload });
  assert.match(json.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(json.expiresInMinutes, 10);
  assert.equal((await srv.call('POST', '/api/transfer/claim', { code: 'AAAAAAAA' })).status, 404);
  assert.equal((await srv.call('POST', '/api/transfer/claim', { code: json.code.toLowerCase() })).json.payload, payload, 'case-insensitive');
  assert.equal((await srv.call('POST', '/api/transfer/claim', { code: json.code })).status, 404, 'works once');
});

test('rate limits stop bulk abuse of transfer codes and lookups', async () => {
  const s = await startServer();
  try {
    let claim;
    for (let i = 0; i < 12; i++) claim = await s.call('POST', '/api/transfer/claim', { code: `WRONG${i}XX` });
    assert.equal(claim.status, 429, 'guessing transfer codes is throttled');
    let make;
    for (let i = 0; i < 12; i++) make = await s.call('POST', '/api/transfer', { payload: 'x' });
    assert.equal(make.status, 429);
  } finally { s.stop(); }
});

test('the owner key never leaves the server', async () => {
  for (const res of [await srv.call('GET', '/api/catalog/US'), await srv.call('POST', '/api/history/resolve', { groups: [{ name: 'Series 3', kind: 'series' }] }), await srv.call('GET', '/')]) {
    assert.ok(!res.text.includes('secret-owner-key'));
  }
});

test('PWA: manifest, icons, service worker and every file it precaches are served', async () => {
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
  const shell = JSON.parse(sw.text.match(/const SHELL_FILES = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(shell.includes('/lib/engine.js') && shell.includes('/demo-catalog.json'));
  for (const f of shell) assert.equal((await srv.call('GET', f)).status, 200, `${f} must exist or the app can't install`);
  assert.equal((await srv.call('GET', '/')).headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await srv.call('GET', '/wrangler.jsonc')).text.includes('r2_buckets'), false, 'config is not served');
});
