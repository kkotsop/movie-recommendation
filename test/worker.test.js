// The Cloudflare Worker, run locally with Wrangler: catalog files, history lookups, transfer codes, static app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { fakeTmdbServer, buildFixtureCatalogs, staticServer } from './fixtures.js';

let fake, files, srv;
before(async () => {
  fake = await fakeTmdbServer();
  const { dir } = await buildFixtureCatalogs(fake, ['US']);
  files = await staticServer(dir);
  srv = await startServer({ CATALOG_BASE: `${files.base}/catalog` });
});
after(() => { srv?.stop(); fake?.close(); files?.close(); });

test("a country's catalog is passed through from where the scheduled job published it", async () => {
  const res = await srv.call('GET', '/api/catalog/US');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
  assert.equal(res.json.region, 'US');
  assert.equal(res.json.titles.length, 50, 'popular titles plus stand-up and concerts');
  assert.ok(files.hits.includes('/catalog/US.json.gz'));
  assert.equal((await srv.call('GET', '/api/catalog/us')).status, 200, 'lowercase is fine');
});

test('the worldwide catalog (titles from other services) is served the same way', async () => {
  const res = await srv.call('GET', '/api/catalog/ALL');
  assert.equal(res.status, 200);
  assert.equal(res.json.region, 'ALL');
  assert.ok(res.json.titles.length >= 30 && res.json.titles.every((t) => t.onNetflix === false));
  assert.equal((await srv.call('GET', '/api/catalog/all')).status, 200, 'lowercase is fine');
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
    ['POST', '/api/cards'], ['POST', '/api/history/import'], ['POST', '/api/history/resolve'], ['GET', '/api/state'], ['POST', '/api/swipe'], ['POST', '/api/login']]) {
    assert.equal((await srv.call(m, p, m === 'POST' ? {} : undefined)).status, 404, `${m} ${p}`);
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

test('every API call is rate limited per visitor, so one client cannot use up the free daily quota', async () => {
  const s = await startServer({ CATALOG_BASE: `${files.base}/catalog` });
  try {
    const statuses = [];
    for (let i = 0; i < 80; i++) statuses.push((await s.call('GET', '/api/catalog/US')).status);
    assert.ok(statuses.slice(0, 40).every((c) => c === 200), 'normal use is never blocked');
    assert.ok(statuses.includes(429), `an abusive client is cut off (saw ${[...new Set(statuses)]})`);
    const blocked = await s.call('GET', '/api/catalog/US');
    if (blocked.status === 429) assert.match(blocked.json.error, /too many requests/i);
  } finally { s.stop(); }
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
  assert.ok(shell.includes('/lib/engine.js') && shell.includes('/demo-catalog.json') && shell.includes('/tmdb-logo.svg'));
  for (const f of shell) assert.equal((await srv.call('GET', f)).status, 200, `${f} must exist or the app can't install`);
  assert.equal((await srv.call('GET', '/')).headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await srv.call('GET', '/wrangler.jsonc')).text.includes('r2_buckets'), false, 'config is not served');
});
