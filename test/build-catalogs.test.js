// The scheduled catalog build, run against a fake TMDB and IMDb.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTmdb } from '../src/tmdb.js';
import { buildCatalogs, readPrevious, writeCatalogs } from '../scripts/build-catalogs.js';
import { fakeTmdbServer, buildFixtureCatalogs, rating, MOVIES, SERIES } from './fixtures.js';

let fake;
before(async () => { fake = await fakeTmdbServer(); });
after(() => fake.close());

const readCatalog = (dir, region) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'catalog', `${region}.json.gz`))));
const detailCalls = () => fake.requests.filter((r) => /^\/3\/(movie|tv)\/\d+/.test(r)).length;
const tmdb = () => createTmdb('k', undefined, fake.base);

test('builds one gzipped catalog per country with IMDb ratings, trending and an index', async () => {
  const now = Date.parse('2026-10-23T03:00:00Z');
  const { dir, catalogs } = await buildFixtureCatalogs(fake, ['US', 'GR'], { now });
  assert.deepEqual([...catalogs.keys()].sort(), ['GR', 'US']);

  const us = readCatalog(dir, 'US');
  assert.equal(us.region, 'US');
  assert.equal(us.builtAt, now);
  assert.equal(us.titles.length, MOVIES.length + SERIES.length);
  assert.ok(us.titles.every((t) => t.onNetflix === true && /netflix\.com\/search/.test(t.netflixUrl) && t.fetchedAt === now));
  const by = Object.fromEntries(us.titles.map((t) => [t.id, t]));
  assert.equal(by['tmdb-movie-105'].imdbRating, rating(105), 'IMDb ratings come from the dataset');
  assert.equal(by['tmdb-movie-105'].imdbVotes, 50000);
  assert.ok(by['tmdb-movie-105'].trend > 0.8, 'trending #1 gets the biggest boost');
  assert.ok(by['tmdb-movie-130'].trend < 0.1);
  assert.match(by['tmdb-movie-105'].poster, /\/p105\.jpg$/);

  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index.regions).sort(), ['GR', 'US']);
  assert.equal(index.regions.US.count, 40);
});

test('a title shared by several countries is fetched from TMDB only once', async () => {
  fake.requests.length = 0;
  await buildFixtureCatalogs(fake, ['US', 'GR', 'DE']);
  assert.equal(fake.requests.filter((r) => r === '/3/movie/101?append_to_response=keywords%2Ccredits%2Cexternal_ids' || r.startsWith('/3/movie/101')).length, 1);
  assert.equal(detailCalls(), MOVIES.length + SERIES.length, 'one detail lookup per distinct title, not per country');
});

test('a country TMDB has no Netflix catalog for is skipped, and the rest still build', async () => {
  const logs = [];
  const catalogs = await buildCatalogs({ tmdb: tmdb(), regions: ['ZZ', 'US'], ratings: async () => new Map(), log: (m) => logs.push(m) });
  assert.deepEqual([...catalogs.keys()], ['US']);
  assert.ok(logs.some((l) => /ZZ: only 0 titles, skipping/.test(l)));
});

test('a later run reuses recent titles and only refetches stale ones', async () => {
  const t0 = Date.parse('2026-10-01T03:00:00Z');
  const { dir } = await buildFixtureCatalogs(fake, ['US'], { now: t0 });

  fake.requests.length = 0;
  const day = 86400000;
  await buildFixtureCatalogs(fake, ['US'], { dir, previous: readPrevious(dir), now: t0 + day });
  assert.equal(detailCalls(), 0, 'the next day, nothing needs fetching again');
  assert.ok(fake.requests.some((r) => r.startsWith('/3/trending/')), 'but trending is refreshed');
  assert.equal(readCatalog(dir, 'US').builtAt, t0 + day);

  fake.requests.length = 0;
  await buildFixtureCatalogs(fake, ['US'], { dir, previous: readPrevious(dir), now: t0 + 20 * day });
  assert.equal(detailCalls(), MOVIES.length + SERIES.length, 'after two weeks everything is refreshed');
});

test('if IMDb is unreachable the build still succeeds and keeps earlier ratings', async () => {
  const t0 = Date.parse('2026-10-01T03:00:00Z');
  const { dir } = await buildFixtureCatalogs(fake, ['US'], { now: t0 });
  const logs = [];
  const catalogs = await buildCatalogs({
    tmdb: tmdb(), regions: ['US'], previous: readPrevious(dir), now: t0 + 86400000,
    ratings: async () => { throw new Error('IMDb dataset download failed (503)'); }, log: (m) => logs.push(m),
  });
  assert.ok(logs.some((l) => /IMDb ratings unavailable/.test(l)));
  assert.equal(catalogs.get('US').titles.find((t) => t.id === 'tmdb-movie-105').imdbRating, rating(105), 'the earlier rating is kept');
});

test('countries that were not rebuilt keep their file and their index entry', async () => {
  const { dir } = await buildFixtureCatalogs(fake, ['US', 'GR'], { now: 1000 });
  const catalogs = await buildCatalogs({ tmdb: tmdb(), regions: ['US'], previous: readPrevious(dir), now: 2000, ratings: async () => new Map() });
  writeCatalogs(dir, catalogs, 2000);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.regions.US.builtAt, 2000);
  assert.equal(index.regions.GR.builtAt, 1000, 'GR is untouched');
  assert.equal(readCatalog(dir, 'GR').builtAt, 1000);
});

test('the catalog file is small enough for a phone', async () => {
  const { dir } = await buildFixtureCatalogs(fake, ['US']);
  const bytes = fs.statSync(path.join(dir, 'catalog', 'US.json.gz')).size;
  assert.ok(bytes < 60_000, `${bytes} bytes for 40 titles`);
});
