// The whole owner-key path on the real Worker runtime: a catalog is built in the background (Workflow),
// stored in R2, scored with IMDb ratings and trending, and watched titles are matched through shared lookups.
// TMDB and IMDb are replaced by a fake server, so no real key or network is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { startServer } from './helpers.js';

const GENRES = ['Drama', 'Comedy', 'Thriller', 'Sci-Fi'];
const MOVIES = Array.from({ length: 30 }, (_, i) => 101 + i);
const SERIES = Array.from({ length: 10 }, (_, i) => 201 + i);
const rating = (id) => 6 + (id % 4); // 6..9, so the IMDb file visibly changes scores

const detail = (kind, id, over = {}) => ({
  id, ...(kind === 'movie' ? { title: `Movie ${id - 100}`, original_title: `Movie ${id - 100}`, release_date: '2020-05-05', runtime: 100 }
    : { name: `Series ${id - 200}`, original_name: `Series ${id - 200}`, first_air_date: '2019-03-03', episode_run_time: [45], number_of_seasons: 2 }),
  genres: [{ name: GENRES[id % GENRES.length] }], overview: `About ${id}`, vote_average: 5, popularity: 10, original_language: 'en',
  poster_path: `/p${id}.jpg`, imdb_id: `tt${id}`, external_ids: { imdb_id: `tt${id}` },
  keywords: kind === 'movie' ? { keywords: [{ name: 'kw' }] } : { results: [{ name: 'kw' }] },
  credits: { cast: [{ name: 'Actor' }], crew: [] }, aggregate_credits: { cast: [{ name: 'Actor' }] }, created_by: [], ...over,
});

let fake, fakePort, requests, srv;

before(async () => {
  requests = [];
  const gz = zlib.gzipSync(`tconst\taverageRating\tnumVotes\n${[...MOVIES, ...SERIES].map((id) => `tt${id}\t${rating(id)}\t50000`).join('\n')}\n`);
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = u.pathname.replace(/^\/3/, '');
    const page1 = u.searchParams.get('page') === '1';
    let m;
    if (u.pathname === '/title.ratings.tsv.gz') { res.writeHead(200); return res.end(gz); }
    if (p === '/discover/movie') return send({ results: page1 && u.searchParams.get('watch_region') !== 'ZZ' ? MOVIES.map((id) => ({ id })) : [] });
    if (p === '/discover/tv') return send({ results: page1 && u.searchParams.get('watch_region') !== 'ZZ' ? SERIES.map((id) => ({ id })) : [] });
    if (p === '/trending/movie/day') return send({ results: page1 ? [{ id: 105 }, { id: 104 }, { id: 103 }] : [] });
    if (p === '/trending/tv/day') return send({ results: [] });
    if (p === '/search/movie') return send({ results: u.searchParams.get('query') === 'Old Movie' ? [{ id: 999, title: 'Old Movie' }] : [] });
    if (p === '/search/tv') return send({ results: u.searchParams.get('query') === 'Series 3' ? [{ id: 203, name: 'Series 3' }] : [] });
    if (p === '/search/multi') return send({ results: [] });
    if (p === '/movie/999') return send(detail('movie', 999, { title: 'Old Movie', original_title: 'Old Movie', genres: [{ name: 'Horror' }], release_date: '1999-01-01' }));
    if ((m = p.match(/^\/(movie|tv)\/(\d+)$/))) return send(detail(m[1], Number(m[2])));
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = fake.address().port;
  srv = await startServer({ TMDB_API_KEY: 'test-key', TMDB_BASE: `http://127.0.0.1:${fakePort}/3`, IMDB_URL: `http://127.0.0.1:${fakePort}/title.ratings.tsv.gz` });
});
after(() => { srv?.stop(); fake?.close(); });

const ask = (route, body = {}) => srv.call('POST', route, { region: 'US', ...body });
const searches = () => requests.filter((r) => r.includes('/search/')).length;

async function until(check, what, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

test('the first visitor gets the sample while the country catalog builds in the background, then the real one', async () => {
  const first = (await srv.call('GET', '/api/catalog?region=US')).json;
  assert.equal(first.source, 'demo');
  assert.ok((await ask('/api/deck', { n: 5 })).json.cards.length > 0, 'swiping works immediately');
  const done = await until(async () => { const c = (await srv.call('GET', '/api/catalog?region=US')).json; return c.source === 'tmdb' && c; }, 'the US catalog');
  assert.equal(done.count, 40);
  assert.equal(done.job.state, 'done');
  assert.match(done.job.message, /40 Netflix titles ready/);
});

test('the built catalog uses TMDB titles, IMDb ratings and trending, and every request after is served from it', async () => {
  const cards = (await ask('/api/cards', { ids: ['tmdb-movie-105', 'tmdb-movie-130', 'tmdb-tv-203'] })).json.cards;
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(by['tmdb-movie-105'].imdbRating, rating(105), 'ratings come from the IMDb file');
  assert.equal(by['tmdb-tv-203'].imdbRating, rating(203));
  assert.ok(by['tmdb-movie-105'].trend > 0.8, `trending #1 is boosted (trend=${by['tmdb-movie-105'].trend})`);
  assert.ok(by['tmdb-movie-130'].trend < 0.1, `the least popular title gets almost no boost (trend=${by['tmdb-movie-130'].trend})`);
  assert.match(by['tmdb-movie-105'].poster, /image\.tmdb\.org\/t\/p\/w780\/p105\.jpg/);
  const deck = (await ask('/api/deck', { n: 30 })).json.cards;
  assert.ok(deck.every((c) => c.id.startsWith('tmdb-')), 'the sample is gone');
  const before = requests.length;
  await ask('/api/deck', { n: 30 });
  assert.equal(requests.length, before, 'serving recommendations never calls TMDB');
});

test('history is matched through shared lookups: the second person pays nothing, and titles that left Netflix still count', async () => {
  const groups = [{ name: 'Series 3', kind: 'series' }, { name: 'Old Movie', kind: 'movie' }, { name: 'Nothing Matches This', kind: 'movie' }];
  const first = (await ask('/api/history/resolve', { history: { groups } })).json;
  assert.deepEqual(first.ids, ['tmdb-tv-203', 'tmdb-movie-999', null]);
  const spent = searches();
  assert.ok(spent >= 3);

  const second = (await ask('/api/history/resolve', { history: { groups } })).json;
  assert.deepEqual(second.ids, first.ids);
  assert.equal(searches(), spent, 'the second person triggers no TMDB searches at all');

  const history = { source: 'csv', entries: 6, groups: groups.map((g, i) => ({ ...g, views: 2, lastWatched: '2026-09-01', titleId: first.ids[i] })) };
  const profile = (await ask('/api/profile', { history })).json;
  assert.equal(profile.history.matched, 2);
  assert.deepEqual(profile.history.recent.map((r) => r.matched), [true, true, false]);
  assert.ok(profile.taste.genres.some((g) => g.name === 'horror'), "Old Movie left Netflix but still shapes the person's taste");

  const deck = (await ask('/api/deck', { n: 30, history })).json.cards.map((c) => c.id);
  assert.ok(!deck.includes('tmdb-tv-203'), 'already watched, so hidden');
  assert.ok(!deck.includes('tmdb-movie-999'), 'no longer on Netflix, so never recommended');
  const rewatch = (await ask('/api/deck', { n: 40, history, settings: { includeWatched: true } })).json.cards;
  assert.ok(rewatch.some((c) => c.id === 'tmdb-tv-203' && c.watched), 'rewatches return when asked for');
});

test('each country has its own catalog, built on first request', async () => {
  const start = (await srv.call('GET', '/api/catalog?region=GR')).json;
  assert.equal(start.source, 'demo');
  const gr = await until(async () => { const c = (await srv.call('GET', '/api/catalog?region=GR')).json; return c.source === 'tmdb' && c; }, 'the GR catalog');
  assert.equal(gr.region, 'GR');
  assert.equal((await srv.call('GET', '/api/catalog?region=US')).json.source, 'tmdb');
});

test('a country TMDB has no Netflix catalog for reports the failure and keeps serving the sample', async () => {
  await srv.call('GET', '/api/catalog?region=ZZ');
  const job = await until(async () => { const j = (await srv.call('GET', '/api/catalog?region=ZZ')).json.job; return j.state === 'error' && j; }, 'the ZZ build to fail');
  assert.match(job.message, /no catalog we can read for ZZ/);
  const c = (await srv.call('GET', '/api/catalog?region=ZZ')).json;
  assert.equal(c.source, 'demo');
  assert.ok((await ask('/api/deck', { region: 'ZZ', n: 5 })).json.cards.length > 0);
});

test('the scheduled job runs cleanly over the countries that were built', async () => {
  const res = await fetch(`${srv.base}/cdn-cgi/handler/scheduled`);
  assert.equal(res.status, 200, await res.text());
  assert.equal((await srv.call('GET', '/api/catalog?region=US')).json.source, 'tmdb', 'and leaves the catalogs in place');
});

test('the TMDB key never leaves the server', async () => {
  for (const route of ['/api/catalog', '/api/profile', '/api/deck']) {
    const res = route === '/api/catalog' ? await srv.call('GET', route) : await ask(route);
    assert.ok(!res.text.includes('test-key'), route);
  }
  assert.ok(!(await srv.call('GET', '/')).text.includes('test-key'));
});
