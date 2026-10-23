import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, nextDeck, feelingLucky, scoreTitle, candidates, dailyPicks, explain, seededRng } from '../public/lib/recommender.js';

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

test('a trending title outranks an otherwise identical one, but taste still wins', () => {
  const profile = buildProfile({ byId, swipes: [{ id: 'space1', action: 'like' }] });
  const hot = { ...byId.get('space2'), trend: 1 };
  const cold = { ...byId.get('space2'), id: 'cold', trend: 0 };
  assert.ok(scoreTitle(profile, hot) > scoreTitle(profile, cold));
  const offTaste = { ...byId.get('romcom1'), trend: 1 };
  assert.ok(scoreTitle(profile, byId.get('space3')) > scoreTitle(profile, offTaste));
});

test('trending titles with no closer match are explained as trending', () => {
  const t = { ...T('x', ['Drama'], []), trend: 0.9 };
  const reason = explain(buildProfile({ byId: new Map() }), t);
  assert.equal(reason.kind, 'trending');
});

test('daily picks are stable for a date, differ across dates, and respect filters', () => {
  const many = Array.from({ length: 40 }, (_, i) => T(`m${i}`, ['Drama'], ['k'], { imdbRating: 7 + (i % 3) / 2 }));
  const profile = buildProfile({ byId: new Map(many.map((t) => [t.id, t])) });
  const args = { catalog: many, profile, swipedIds: new Set(['m0']), watchedIds: new Set(['m1']), settings: {} };
  const ids = (date) => dailyPicks({ ...args, date }).map((c) => c.id);
  const a = ids('2026-10-23');
  assert.equal(a.length, 5);
  assert.deepEqual(a, ids('2026-10-23'));
  assert.notDeepEqual(a, ids('2026-10-24'));
  assert.equal(new Set(a).size, a.length);
  assert.ok(!a.includes('m0') && !a.includes('m1'));
});

test('seededRng is deterministic and in [0, 1)', () => {
  const r1 = seededRng('seed');
  const r2 = seededRng('seed');
  for (let i = 0; i < 100; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test('"later" is a mild yes: it hides the title, warms taste a little, and never counts as a like', () => {
  const other = T('other', ['Western'], ['desert']);
  const all = new Map([...catalog, other].map((t) => [t.id, t]));
  const score = (swipes, id) => scoreTitle(buildProfile({ byId: all, swipes }), all.get(id));
  const like = { id: 'romcom1', action: 'like' };
  assert.ok(score([{ id: 'space1', action: 'later' }, like], 'space2') > score([like], 'space2'), 'later nudges toward similar titles');
  assert.ok(score([{ id: 'space1', action: 'later' }, like], 'space2') < score([{ id: 'space1', action: 'like' }, like], 'space2'), 'but less than a like');
  assert.ok(score([{ id: 'space1', action: 'nope' }, like], 'space2') < score([like], 'space2'), 'and a nope pushes the other way');
  assert.equal(buildProfile({ byId: all, swipes: [{ id: 'space1', action: 'later' }] }).anchors.length, 0, '"because you liked" never points at something only saved for later');
  assert.ok(!candidates({ catalog, swipedIds: new Set(['space1']), watchedIds: new Set(), settings: {} }).some((t) => t.id === 'space1'), 'and it is hidden from the deck');
});

test('stand-up and concerts form their own taste: loving specials surfaces more specials', () => {
  const special = (id, title, extra = {}) => T(id, ['Comedy'], ['stand-up comedy'], { format: 'standup', title, ...extra });
  const movieComedy = T('rom', ['Comedy'], ['wedding'], { imdbRating: 7.5 });
  const cat = [special('s1', 'Special one'), special('s2', 'Special two'), movieComedy, T('thrill', ['Thriller'], ['heist'])];
  const map = new Map(cat.map((t) => [t.id, t]));
  const profile = buildProfile({ byId: map, swipes: [{ id: 's1', action: 'super' }] });
  assert.ok(scoreTitle(profile, map.get('s2')) > scoreTitle(profile, map.get('rom')), 'the other special beats a rom-com that is also "Comedy"');
});

test('titles not on Netflix only appear when the person asks for titles from anywhere', () => {
  const other = [T('on', ['Drama'], [], { onNetflix: true }), T('off', ['Drama'], [], { onNetflix: false })];
  const ids = (settings) => candidates({ catalog: other, swipedIds: new Set(), watchedIds: new Set(), settings }).map((t) => t.id);
  assert.deepEqual(ids({}), ['on']);
  assert.deepEqual(ids({ anywhere: true }).sort(), ['off', 'on']);
});
