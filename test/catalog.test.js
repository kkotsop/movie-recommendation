import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SWIPEFLICK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'swipeflick-'));
process.env.IMDB_RETRY_MS = '1';
const { buildTmdbCatalog, loadDemoCatalog, resolveByTitle } = await import('../src/catalog.js');
const { mapDetails } = await import('../src/tmdb.js');

const movie = { id: 1, title: 'Roma', original_title: 'Roma', release_date: '2018-11-21', runtime: 135, genres: [{ name: 'Drama' }], keywords: { keywords: [{ name: 'maid' }] }, credits: { cast: [{ name: 'Yalitza Aparicio' }], crew: [{ job: 'Director', name: 'Alfonso Cuarón' }] }, imdb_id: 'tt6155172', original_language: 'es', poster_path: '/p.jpg', vote_average: 7.7 };
const show = { id: 2, name: 'Dark', original_name: 'Dark', first_air_date: '2017-12-01', last_air_date: '2020-06-27', status: 'Ended', number_of_seasons: 3, genres: [{ name: 'Mystery' }], keywords: { results: [{ name: 'time travel' }] }, aggregate_credits: { cast: [{ name: 'Louis Hofmann' }] }, created_by: [{ name: 'Baran bo Odar' }], external_ids: { imdb_id: 'tt5753856' }, original_language: 'de', vote_average: 8.4 };

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

test('buildTmdbCatalog discovers Netflix titles and resolves watch history', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const json = (body) => new Response(JSON.stringify(body), { status: 200 });
    if (u.hostname === 'datasets.imdbws.com') return new Response('nope', { status: 503 });
    if (u.pathname === '/3/discover/movie') return json({ results: u.searchParams.get('page') === '1' ? [{ id: 1 }] : [] });
    if (u.pathname === '/3/discover/tv') return json({ results: [] });
    if (u.pathname === '/3/search/tv') return json({ results: [{ id: 2, name: 'Dark' }] });
    if (u.pathname === '/3/movie/1') return json(movie);
    if (u.pathname === '/3/tv/2') return json(show);
    return new Response('{}', { status: 404 });
  };
  try {
    const { titles, groups } = await buildTmdbCatalog({ key: 'k', region: 'GR', groups: [{ name: 'Dark', kind: 'series', views: 3 }] });
    assert.ok(calls.some((c) => c.includes('with_watch_providers=8') && c.includes('watch_region=GR')));
    const roma = titles.find((t) => t.id === 'tmdb-movie-1');
    const dark = titles.find((t) => t.id === 'tmdb-tv-2');
    assert.equal(roma.onNetflix, true);
    assert.equal(dark.onNetflix, false, 'watched title not in the discover lists');
    assert.equal(groups[0].titleId, 'tmdb-tv-2');
    assert.match(roma.netflixUrl, /netflix\.com\/search\?q=Roma/);
    assert.equal(calls.filter((c) => c.includes('title.ratings')).length, 3, 'IMDb download is retried before giving up');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('demo catalog loads and history matches alternative titles', () => {
  const titles = loadDemoCatalog();
  assert.ok(titles.length >= 90);
  assert.ok(titles.every((t) => t.imdbId && t.imdbRating && t.genres.length));
  const [g] = resolveByTitle([{ name: 'La casa de papel', kind: 'series' }], titles);
  assert.equal(titles.find((t) => t.id === g.titleId)?.title, 'Money Heist');
});
