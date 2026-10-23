// Tiny JSON-file store. Everything stays on this machine in ./data.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.SWIPEFLICK_DATA || path.resolve('data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

export const DEFAULT_SETTINGS = {
  includeWatched: false,
  types: 'both', // 'both' | 'movie' | 'series'
  minRating: 0,
  region: 'US',
  tmdbKey: process.env.TMDB_API_KEY || '',
};

function fresh() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    onboarded: false,
    history: null, // {source, importedAt, entries, groups: [{name, kind, views, firstWatched, lastWatched, titleId}]}
    swipes: [], // [{id, action, at}]
  };
}

export function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const base = fresh();
    return { ...base, ...s, settings: { ...base.settings, ...s.settings, tmdbKey: s.settings?.tmdbKey || base.settings.tmdbKey } };
  } catch {
    return fresh();
  }
}

export function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

export function readCache(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(name, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(value));
}
