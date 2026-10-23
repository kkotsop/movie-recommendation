import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, nextDeck, feelingLucky, scoreTitle, candidates } from '../src/recommender.js';

const T = (id, genres, keywords, extra = {}) => ({ id, title: id, type: 'movie', year: 2020, genres, keywords, imdbRating: 7.5, imdbVotes: 100000, ...extra });

const catalog = [
  T('space1', ['Sci-Fi'], ['space', 'aliens']),
  T('space2', ['Sci-Fi'], ['space', 'astronaut']),
  T('space3', ['Sci-Fi', 'Thriller'], ['space', 'aliens']),
  T('romcom1', ['Romance', 'Comedy'], ['wedding', 'new york']),
  T('romcom2', ['Romance', 'Comedy'], ['wedding', 'paris']),
  T('horror1', ['Horror'], ['ghosts', 'haunted house'], { imdbRating: 8.6 }),
  T('series1', ['Sci-Fi'], ['space'], { type: 'series' }),
];
const byId = new Map(catalog.map((t) => [t.id, t]));
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('liked features score higher than noped ones', () => {
  const profile = buildProfile({ byId, swipes: [{ id: 'space1', action: 'like' }, { id: 'romcom1', action: 'nope' }] });
  assert.ok(scoreTitle(profile, byId.get('space2')) > scoreTitle(profile, byId.get('romcom2')));
});

test('watch history seeds the profile', () => {
  const profile = buildProfile({ byId, watched: [{ titleId: 'romcom1', views: 1, lastWatched: new Date().toISOString() }] });
  assert.ok(scoreTitle(profile, byId.get('romcom2')) > scoreTitle(profile, byId.get('space2')));
});

test('swiped titles never come back and watched titles are hidden unless included', () => {
  const swipedIds = new Set(['space1']);
  const watchedIds = new Set(['space2']);
  const ids = (settings) => candidates({ catalog, swipedIds, watchedIds, settings }).map((t) => t.id);
  assert.ok(!ids({}).includes('space1'));
  assert.ok(!ids({}).includes('space2'));
  assert.ok(ids({ includeWatched: true }).includes('space2'));
  assert.ok(!ids({ includeWatched: true }).includes('space1'));
});

test('type and rating filters apply', () => {
  const base = { catalog, swipedIds: new Set(), watchedIds: new Set() };
  assert.deepEqual(candidates({ ...base, settings: { types: 'series' } }).map((t) => t.id), ['series1']);
  assert.deepEqual(candidates({ ...base, settings: { minRating: 8 } }).map((t) => t.id), ['horror1']);
});

test('deck puts the most similar titles first and contains no duplicates', () => {
  const profile = buildProfile({ byId, swipes: [{ id: 'space1', action: 'super' }] });
  const deck = nextDeck({ catalog, profile, swipedIds: new Set(['space1']), watchedIds: new Set(), settings: {}, n: 6, rng: seq(0.99, 0.01) });
  assert.equal(new Set(deck.map((c) => c.id)).size, deck.length);
  assert.ok(['space3', 'space2', 'series1'].includes(deck[0].id));
  assert.match(deck[0].reason.text, /Because you loved space1/);
});

test('rewatches are recommended at a lower rate than new titles', () => {
  // two identical titles, one watched: over many decks the unwatched one should lead far more often
  const twins = [T('new', ['Drama'], ['x']), T('old', ['Drama'], ['x'])];
  const map = new Map(twins.map((t) => [t.id, t]));
  const profile = buildProfile({ byId: map });
  let newFirst = 0;
  let r = 1;
  const rng = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) {
    const deck = nextDeck({ catalog: twins, profile, swipedIds: new Set(), watchedIds: new Set(['old']), settings: { includeWatched: true }, n: 1, rng });
    if (deck[0].id === 'new') newFirst++;
  }
  assert.ok(newFirst > 1300 && newFirst < 1800, `new first ${newFirst}/2000`);
});

test('feeling lucky returns a single high-rated, unswiped, unwatched title', () => {
  const profile = buildProfile({ byId, swipes: [{ id: 'horror1', action: 'like' }] });
  const pick = feelingLucky({ catalog, profile, swipedIds: new Set(['horror1']), watchedIds: new Set(['space1']), settings: {}, rng: () => 0 });
  assert.ok(pick);
  assert.notEqual(pick.id, 'horror1');
  assert.notEqual(pick.id, 'space1');
  assert.ok(pick.imdbRating >= 7.5);
});

test('feeling lucky falls back when nothing is rated 7.5+', () => {
  const low = [T('a', ['Drama'], [], { imdbRating: 6.1 })];
  const pick = feelingLucky({ catalog: low, profile: buildProfile({ byId: new Map() }), swipedIds: new Set(), watchedIds: new Set(), settings: {}, rng: () => 0 });
  assert.equal(pick.id, 'a');
});
