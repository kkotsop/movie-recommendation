// Shared on-disk cache (the Netflix catalog, TMDB lookups, IMDb ratings). Nothing here is about a person:
// each person's history, swipes and settings live on their own device.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.SWIPEFLICK_DATA || path.resolve('data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');

export function readCache(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(name, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}
