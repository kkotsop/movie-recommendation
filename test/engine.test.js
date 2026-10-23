// The recommendation engine, which runs on the phone. These tests use the built-in sample catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as engine from '../public/lib/engine.js';
import { parseViewingHistoryCsv, groupHistory } from '../public/lib/history.js';

const catalog = engine.demoCatalog(JSON.parse(fs.readFileSync(new URL('../public/demo-catalog.json', import.meta.url), 'utf8')));
const person = (over = {}) => ({ settings: { includeWatched: false, types: 'both', minRating: 0 }, swipes: [], history: null, ...over });
const CSV = 'Title,Date\n"Dark: Season 1: Secrets","9/28/26"\n"Stranger Things: Season 4: Chapter One","9/20/26"\n"The Irishman","8/30/26"\n';
const historyOf = (csv = CSV) => {
  const entries = parseViewingHistoryCsv(csv);
  return { source: 'csv', importedAt: '2026-10-01T00:00:00Z', entries: entries.length, groups: groupHistory(entries), titles: {} };
};

test('the sample catalog has 100 titles and a deck has unique cards, honours exclude and caps n', () => {
  assert.equal(catalog.source, 'demo');
  assert.equal(engine.netflixCount(catalog), 100);
  const cards = engine.deck(catalog, person(), { n: 10 });
  assert.equal(cards.length, 10);
  assert.equal(new Set(cards.map((c) => c.id)).size, 10);
  const again = engine.deck(catalog, person(), { n: 30, exclude: [cards[0].id] });
  assert.ok(!again.some((c) => c.id === cards[0].id));
  assert.equal(engine.deck(catalog, person(), { n: 999 }).length, 30);
});

test('swiped titles never come back, and swipes steer the deck and the taste profile', () => {
  const [a, b, c] = engine.deck(catalog, person(), { n: 3 });
  const swipes = [{ id: a.id, action: 'like' }, { id: b.id, action: 'nope' }, { id: c.id, action: 'super' }];
  const me = person({ swipes });
  const deck = engine.deck(catalog, me, { n: 30 }).map((x) => x.id);
  assert.ok(![a.id, b.id, c.id].some((id) => deck.includes(id)));

  const p = engine.profile(catalog, me);
  assert.deepEqual([p.stats.likes, p.stats.supers, p.stats.nopes], [1, 1, 1]);
  assert.ok(p.taste.genres.length > 0);

  const likes = engine.likes(catalog, me);
  assert.deepEqual(likes.map((l) => l.id), [c.id, a.id], 'newest first, nopes left out');
  assert.equal(likes[0].action, 'super');

  // rewinding is just one swipe fewer: the title is available again
  assert.equal(engine.profile(catalog, person({ swipes: swipes.slice(0, 2) })).stats.remaining, p.stats.remaining + 1);
  assert.deepEqual(engine.cards(catalog, me, [c.id, 'not-real']).map((x) => x.id), [c.id]);
});

test('settings filter the deck', () => {
  const deck = engine.deck(catalog, person({ settings: { includeWatched: false, types: 'series', minRating: 8.5 } }), { n: 30 });
  assert.ok(deck.length > 0 && deck.every((c) => c.type === 'series' && c.imdbRating >= 8.5));
});

test('history is matched, hidden by default, and rewatches come back at a lower rate when included', () => {
  const history = historyOf();
  assert.equal(history.groups.length, 3);
  const p = engine.profile(catalog, person({ history }));
  assert.equal(p.history.matched, 3);
  assert.ok(p.history.recent.every((r) => r.matched));

  assert.equal(engine.deck(catalog, person({ history }), { n: 30 }).filter((c) => c.watched).length, 0);
  const shown = engine.deck(catalog, person({ history, settings: { includeWatched: true, types: 'both', minRating: 0 } }), { n: 30 });
  assert.ok(shown.some((c) => c.watched), 'rewatches appear when included');
  assert.ok(shown.slice(0, 3).filter((c) => c.watched).length < 3, 'but not all at the top');
  assert.ok(engine.profile(catalog, person({ history })).taste.genres.length > 0 && engine.profile(catalog, person()).taste.genres.length === 0,
    'history is what builds the taste profile');
});

test('watched titles the catalog does not have still shape taste, using what the phone remembers about them', () => {
  const history = historyOf('Title,Date\n"Obscure Horror","9/28/26"\n"Another Obscure Horror","9/20/26"\n');
  const horror = (name, id) => ({ id, type: 'movie', title: name, aka: [], year: 1999, genres: ['Horror'], keywords: ['ghost'], creators: [], cast: [], language: 'en', onNetflix: false });
  history.titles = { 'tmdb-movie-1': horror('Obscure Horror', 'tmdb-movie-1'), 'tmdb-movie-2': horror('Another Obscure Horror', 'tmdb-movie-2') };
  history.groups[0].titleId = 'tmdb-movie-1';
  history.groups[1].titleId = 'tmdb-movie-2';
  const me = person({ history });
  const p = engine.profile(catalog, me);
  assert.equal(p.history.matched, 2);
  assert.equal(p.taste.genres[0].name, 'horror');
  assert.ok(engine.deck(catalog, me, { n: 30 }).every((c) => c.onNetflix !== false), 'titles that left Netflix are never recommended');
  assert.deepEqual(engine.unmatchedGroups(catalog, me), []);
});

test('groups nothing recognises are reported, so they can be looked up by name', () => {
  const history = historyOf('Title,Date\n"Dark: Season 1: x","9/28/26"\n"A Film Nobody Has Heard Of","9/20/26"\n');
  assert.deepEqual(engine.unmatchedGroups(catalog, person({ history })).map((g) => g.name), ['A Film Nobody Has Heard Of']);
});

test('feeling lucky returns one highly rated unswiped title and honours exclude', () => {
  const first = engine.lucky(catalog, person());
  assert.ok(first.imdbRating >= 7.5);
  assert.notEqual(engine.lucky(catalog, person(), { exclude: [first.id] }).id, first.id);
  const none = engine.makeCatalog('demo', []);
  assert.equal(engine.lucky(none, person()), null);
});

test("today's picks are stable per date, differ across dates, and exclude what you've swiped", () => {
  const a = engine.daily(catalog, person(), '2026-10-23');
  assert.equal(a.length, 5);
  assert.deepEqual(a.map((x) => x.id), engine.daily(catalog, person(), '2026-10-23').map((x) => x.id));
  assert.notDeepEqual(a.map((x) => x.id), engine.daily(catalog, person(), '2026-10-24').map((x) => x.id));
  assert.ok(a.every((x) => x.imdbRating >= 7));
  const swipes = a.slice(0, 2).map((x) => ({ id: x.id, action: 'like' }));
  const after = engine.daily(catalog, person({ swipes }), '2026-10-23').map((x) => x.id);
  assert.ok(!after.includes(swipes[0].id) && !after.includes(swipes[1].id));
});

test('two people with different tastes get different recommendations from the same catalog', () => {
  const pick = (genre) => engine.deck(catalog, person(), { n: 30 }).filter((c) => c.genres.includes(genre)).slice(0, 4);
  const loves = (cards) => person({ swipes: cards.map((c) => ({ id: c.id, action: 'super' })) });
  const a = engine.profile(catalog, loves(pick('Horror')));
  const b = engine.profile(catalog, loves(pick('Comedy')));
  assert.notDeepEqual(a.taste.genres.slice(0, 2).map((g) => g.name), b.taste.genres.slice(0, 2).map((g) => g.name));
  assert.equal(engine.profile(catalog, person()).stats.supers, 0);
});

test('swipes made on the sample still count once the real catalog arrives', () => {
  const sample = engine.deck(catalog, person(), { n: 1 })[0];
  assert.match(sample.id, /^imdb-tt/);
  const real = engine.makeCatalog('tmdb', [
    { ...sample, id: 'tmdb-movie-77', onNetflix: true },
    ...Array.from({ length: 5 }, (_, i) => ({ ...sample, id: `tmdb-movie-${i}`, imdbId: `tt${i}`, title: `Other ${i}`, onNetflix: true })),
  ], 1);
  const me = person({ swipes: [{ id: sample.id, action: 'like' }] });
  assert.ok(!engine.deck(real, me, { n: 30 }).some((c) => c.id === 'tmdb-movie-77'), 'already swiped on the sample');
  assert.deepEqual(engine.likes(real, me).map((l) => l.id), ['tmdb-movie-77']);
});
