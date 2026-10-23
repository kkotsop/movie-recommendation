import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../src/engine.js';

const titles = JSON.parse(fs.readFileSync(new URL('../data/demo-catalog.json', import.meta.url), 'utf8')).titles;
const q = (s = '') => new URLSearchParams(s);

function setup(capabilities = { netflixLogin: false, tmdb: false }) {
  const host = {
    state: { settings: { includeWatched: false, types: 'both', minRating: 0, region: 'US', tmdbKey: '' }, onboarded: false, history: null, swipes: [] },
    catalog: { source: 'demo', titles, byId: new Map(titles.map((t) => [t.id, t])), builtAt: null },
    jobs: { netflix: { state: 'idle' }, catalog: { state: 'idle' } },
    capabilities,
    saves: 0,
    save() { host.saves++; },
    resetAll: () => ({ settings: { ...host.state.settings }, onboarded: false, history: null, swipes: [] }),
  };
  return { host, r: createEngine(host).routes };
}

const CSV = 'Title,Date\n"Dark: Season 1: Secrets","10/20/26"\n"Dark: Season 1: Lies","10/21/26"\n"The Irishman","5/15/26"\n';

test('swipe, rewind and unswipe update stats and persist', () => {
  const { host, r } = setup();
  const [a, b] = r['GET /api/deck'](q('n=2')).cards;
  assert.equal(r['POST /api/swipe'](q(), { id: a.id, action: 'like' }).stats.likes, 1);
  r['POST /api/swipe'](q(), { id: b.id, action: 'nope' });
  assert.ok(host.saves >= 2);
  assert.equal(r['POST /api/rewind'](q()).card.id, b.id);
  assert.deepEqual(r['POST /api/rewind'](q()).action, 'like');
  assert.equal(r['POST /api/rewind'](q())[0], 404);
  assert.deepEqual(r['POST /api/swipe'](q(), { id: 'nope', action: 'like' })[0], 400);
});

test('swiped titles never come back in later decks', () => {
  const { r } = setup();
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    for (const c of r['GET /api/deck'](q('n=10')).cards) {
      assert.ok(!seen.has(c.id), `${c.title} dealt twice`);
      seen.add(c.id);
      r['POST /api/swipe'](q(), { id: c.id, action: i % 2 ? 'like' : 'nope' });
    }
  }
  assert.equal(r['GET /api/state'](q()).stats.remaining, 0);
  assert.equal(r['GET /api/deck'](q()).cards.length, 0);
});

test('CSV import marks watched titles and the include-watched switch brings them back', () => {
  const { r } = setup();
  assert.equal(r['POST /api/history/csv'](q(), 'not a netflix file')[0], 400);
  const res = r['POST /api/history/csv'](q(), CSV);
  assert.equal(res.entries, 3);
  assert.equal(res.titles, 2);
  const state = r['GET /api/state'](q());
  assert.equal(state.history.matched, 2);
  const names = () => r['GET /api/deck'](q('n=30')).cards.map((c) => c.title);
  assert.ok(!names().includes('Dark') && !names().includes('The Irishman'));
  r['POST /api/settings'](q(), { includeWatched: true });
  const all = r['GET /api/deck'](q('n=30')).cards;
  assert.ok(all.find((c) => c.title === 'Dark')?.watched);
});

test('settings are validated; region/tmdb are ignored without the capability', () => {
  const { r } = setup();
  const s = r['POST /api/settings'](q(), { types: 'series', minRating: 99, region: 'GR', tmdbKey: 'x', includeWatched: 'yes' });
  assert.equal(s.settings.types, 'series');
  assert.equal(s.settings.minRating, 9.5);
  assert.equal(s.settings.region, 'US');
  assert.equal(s.settings.hasTmdbKey, false);
  assert.equal(s.settings.includeWatched, false);
  assert.ok(r['GET /api/deck'](q('n=30')).cards.every((c) => c.type === 'series'));
  const tm = setup({ netflixLogin: true, tmdb: true }).r['POST /api/settings'](q(), { region: 'GR', tmdbKey: ' k ' });
  assert.equal(tm.settings.region, 'GR');
  assert.equal(tm.settings.hasTmdbKey, true);
  assert.equal('tmdbKey' in tm.settings, false, 'the key is never sent to the UI');
});

test('lucky respects excludes and reset clears swipes (or everything)', () => {
  const { r } = setup();
  const first = r['GET /api/lucky'](q()).card;
  assert.ok(first.imdbRating >= 7.5);
  const second = r['GET /api/lucky'](q(`exclude=${first.id}`)).card;
  assert.notEqual(second.id, first.id);
  r['POST /api/swipe'](q(), { id: first.id, action: 'super' });
  r['POST /api/history/csv'](q(), CSV);
  assert.equal(r['GET /api/likes'](q()).likes[0].action, 'super');
  assert.equal(r['POST /api/reset'](q(), { scope: 'swipes' }).stats.supers, 0);
  assert.ok(r['GET /api/state'](q()).history, 'history kept');
  const all = r['POST /api/reset'](q(), { scope: 'all' });
  assert.equal(all.history, null);
  assert.equal(all.onboarded, false);
});
