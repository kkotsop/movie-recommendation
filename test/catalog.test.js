import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { discoverRefs, fetchTitles, applyRatings, resolveHistory, resolveByTitle, MIN_NETFLIX_TITLES } from '../src/catalog.js';
import { loadDemoCatalog } from '../src/demo.js';
import { imdbRatings } from '../src/imdb.js';
import { createTmdb, mapDetails } from '../src/tmdb.js';

const movie = { id: 1, title: 'Roma', original_title: 'Roma', release_date: '2018-11-21', runtime: 135, genres: [{ name: 'Drama' }], keywords: { keywords: [{ name: 'maid' }] }, credits: { cast: [{ name: 'Yalitza Aparicio' }], crew: [{ job: 'Director', name: 'Alfonso Cuarón' }] }, imdb_id: 'tt6155172', original_language: 'es', poster_path: '/p.jpg', vote_average: 7.7 };
const show = { id: 2, name: 'Dark', original_name: 'Dark', first_air_date: '2017-12-01', last_air_date: '2020-06-27', status: 'Ended', number_of_seasons: 3, genres: [{ name: 'Mystery' }], keywords: { results: [{ name: 'time travel' }] }, aggregate_credits: { cast: [{ name: 'Louis Hofmann' }] }, created_by: [{ name: 'Baran bo Odar' }], external_ids: { imdb_id: 'tt5753856' }, original_language: 'de', vote_average: 8.4 };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** A TMDB client wired to canned answers; records every path it was asked for. */
function fakeTmdb(routes, calls = []) {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/3/, '');
    calls.push(path + u.search);
    const answer = routes[path];
    return answer ? json(typeof answer === 'function' ? answer(u) : answer) : json({}, 404);
  };
  return createTmdb('key', fetchImpl, 'https://tmdb.test/3');
}

/** The shared lookup table every person uses, in memory. */
function memoryShared() {
  const search = {};
  const titles = new Map();
  return {
    search, titles,
    getSearch: async (keys) => Object.fromEntries(keys.filter((k) => k in search).map((k) => [k, search[k]])),
    putSearch: async (entries) => Object.assign(search, entries),
    getTitles: async (ids) => ids.filter((id) => titles.has(id)).map((id) => titles.get(id)),
    putTitles: async (list) => list.forEach((t) => titles.set(t.id, t)),
  };
}

test('mapDetails normalises TMDB movies and series', () => {
  const m = mapDetails('movie', movie);
  assert.equal(m.id, 'tmdb-movie-1');
  assert.deepEqual(m.creators, ['Alfonso Cuarón']);
  assert.equal(m.poster, 'https://image.tmdb.org/t/p/w780/p.jpg');
  const s = mapDetails('tv', show);
  assert.equal(s.type, 'series');
  assert.equal(s.seasons, 3);
  assert.equal(s.endYear, 2020);
  assert.equal(s.imdbId, 'tt5753856');
  assert.deepEqual(s.keywords, ['time travel']);
});

test('discoverRefs lists what is on Netflix in the country, deduplicated', async () => {
  const calls = [];
  const tmdb = fakeTmdb({
    '/discover/movie': (u) => ({ results: u.searchParams.get('page') === '1' ? [{ id: 1 }, { id: 3 }] : [] }),
    '/discover/tv': (u) => ({ results: u.searchParams.get('page') === '1' ? [{ id: 2 }, { id: 1 }] : [] }),
  }, calls);
  const refs = await discoverRefs(tmdb, 'GR');
  assert.deepEqual(refs.map((r) => `${r.kind}:${r.id}`).sort(), ['movie:1', 'movie:3', 'tv:1', 'tv:2']);
  assert.ok(calls.every((c) => c.includes('watch_region=GR') && c.includes('with_watch_providers=8')));
});

test('fetchTitles returns full details marked as on Netflix, skipping failures', async () => {
  const tmdb = fakeTmdb({ '/movie/1': movie, '/tv/2': show });
  const titles = await fetchTitles(tmdb, [{ kind: 'movie', id: 1 }, { kind: 'tv', id: 2 }, { kind: 'movie', id: 404 }]);
  assert.deepEqual(titles.map((t) => t.id), ['tmdb-movie-1', 'tmdb-tv-2']);
  assert.ok(titles.every((t) => t.onNetflix === true));
  assert.match(titles[0].netflixUrl, /netflix\.com\/search\?q=Roma/);
  assert.ok(MIN_NETFLIX_TITLES > 0);
});

test('applyRatings copies IMDb scores onto matching titles only', () => {
  const titles = [{ id: 'a', imdbId: 'tt1' }, { id: 'b', imdbId: 'tt2' }, { id: 'c' }];
  applyRatings(titles, { tt1: { rating: 8.1, votes: 1000 } });
  assert.deepEqual([titles[0].imdbRating, titles[0].imdbVotes, titles[1].imdbRating, titles[2].imdbRating], [8.1, 1000, undefined, undefined]);
});

test('imdbRatings streams the gzipped dataset, keeps only requested ids, and retries failures', async () => {
  const tsv = 'tconst\taverageRating\tnumVotes\ntt0000001\t5.7\t2000\ntt5753856\t8.8\t500000\ntt6155172\t7.7\t120000\ntt9999999\t1.0\t5\n';
  const gz = zlib.gzipSync(tsv);
  let attempts = 0;
  const fetchImpl = async () => (++attempts < 3 ? new Response('busy', { status: 503 }) : new Response(gz));
  const r = await imdbRatings(['tt5753856', 'tt6155172', 'tt0'], { fetchImpl, retryMs: 1 });
  assert.equal(attempts, 3);
  assert.deepEqual([...r.keys()].sort(), ['tt5753856', 'tt6155172']);
  assert.deepEqual(r.get('tt5753856'), { rating: 8.8, votes: 500000 });
  await assert.rejects(() => imdbRatings(['x'], { fetchImpl: async () => new Response('', { status: 503 }), retries: 2, retryMs: 1 }), /503/);
});

test('demo catalog loads and history matches alternative titles', () => {
  const titles = loadDemoCatalog();
  assert.ok(titles.length >= 90);
  assert.ok(titles.every((t) => t.imdbId && t.imdbRating && t.genres.length));
  const [g] = resolveByTitle([{ name: 'La casa de papel', kind: 'series' }], titles);
  assert.equal(titles.find((t) => t.id === g.titleId)?.title, 'Money Heist');
});

test('resolveHistory matches titles on TMDB once, shares the answer, and only fetches what is unknown', async () => {
  const calls = [];
  const tmdb = fakeTmdb({
    '/search/tv': { results: [{ id: 2, name: 'Dark' }] },
    '/search/movie': { results: [{ id: 1, title: 'Roma' }] },
    '/tv/2': show, '/movie/1': movie,
  }, calls);
  const shared = memoryShared();
  const groups = [{ name: 'Dark', kind: 'series' }, { name: 'Roma', kind: 'movie' }];

  const first = await resolveHistory({ tmdb, groups, knownIds: new Set(['tmdb-movie-1']), shared });
  assert.deepEqual(first, ['tmdb-tv-2', 'tmdb-movie-1']);
  assert.deepEqual([...shared.titles.keys()], ['tmdb-tv-2'], 'Roma is already in the catalog, so only Dark is fetched');
  assert.equal(shared.titles.get('tmdb-tv-2').onNetflix, false);

  calls.length = 0;
  const again = await resolveHistory({ tmdb, groups, knownIds: new Set(['tmdb-movie-1']), shared });
  assert.deepEqual(again, first);
  assert.deepEqual(calls, [], 'the second person pays nothing: no search and no detail lookup');
});

test('resolveHistory remembers titles TMDB has no match for, so nobody searches for them again', async () => {
  const calls = [];
  const tmdb = fakeTmdb({ '/search/movie': { results: [] }, '/search/multi': { results: [] } }, calls);
  const shared = memoryShared();
  const groups = [{ name: 'A Film Nobody Has Heard Of', kind: 'movie' }];
  assert.deepEqual(await resolveHistory({ tmdb, groups, shared }), [null]);
  const searches = calls.length;
  assert.ok(searches > 0);
  assert.deepEqual(await resolveHistory({ tmdb, groups, shared }), [null]);
  assert.equal(calls.length, searches);
});
