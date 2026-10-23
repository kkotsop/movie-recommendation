import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTrending, applyTrending } from '../src/catalog.js';

function fakeTmdb(calls = []) {
  return {
    async get(path, params) {
      calls.push([path, params]);
      const kind = path.includes('/movie') ? 'movie' : 'tv';
      const base = kind === 'movie' ? 100 : 200;
      if (path.startsWith('/trending/')) return { results: [{ id: base + 1 }, { id: base + 2 }] };
      return { results: [{ id: base + 2 }, { id: base + 3 }] };
    },
  };
}

test('fetchTrending combines daily trending and Netflix popularity per title', async () => {
  const calls = [];
  const scores = await fetchTrending(fakeTmdb(calls), 'GR');
  assert.ok(scores['tmdb-movie-101'] > scores['tmdb-movie-103'], 'top trending beats a lower popularity-only title');
  assert.ok(scores['tmdb-movie-102'] > 0, 'titles in both lists keep their best score');
  assert.ok(Object.values(scores).every((v) => v > 0 && v <= 1));
  const discover = calls.find(([p]) => p === '/discover/movie')[1];
  assert.equal(discover.watch_region, 'GR');
  assert.equal(discover.with_watch_providers, 8);
});

test('applyTrending sets trend on every title and zeroes the rest', () => {
  const titles = [{ id: 'tmdb-movie-1' }, { id: 'tmdb-movie-2', trend: 0.9 }];
  applyTrending(titles, { 'tmdb-movie-1': 0.7 });
  assert.equal(titles[0].trend, 0.7);
  assert.equal(titles[1].trend, 0);
});
