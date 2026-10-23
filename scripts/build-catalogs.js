// Builds the Netflix catalog for each country (what's on Netflix, cast, keywords, IMDb ratings, what's
// trending) and writes one gzipped file per country, ready to be published as static files.
// A scheduled GitHub job runs this for free. Run it by hand with:
//   TMDB_API_KEY=your-key npm run catalogs
// Titles seen in an earlier run are reused, so a daily run only fetches what is new.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createTmdb } from '../src/tmdb.js';
import { discoverRefs, fetchTitles, applyRatings, fetchTrending, applyTrending, MIN_NETFLIX_TITLES } from '../src/catalog.js';
import { imdbRatings } from '../src/imdb.js';
import { REGIONS } from '../public/lib/regions.js';

const DAY = 86400000;
const idOf = ({ kind, id }) => `tmdb-${kind}-${id}`;

/** Every title from the catalogs of an earlier run, by id. */
export function readPrevious(dir) {
  const previous = new Map();
  const folder = path.join(dir, 'catalog');
  if (!fs.existsSync(folder)) return previous;
  for (const file of fs.readdirSync(folder).filter((f) => f.endsWith('.json.gz'))) {
    try {
      const { titles } = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(folder, file))));
      for (const t of titles) previous.set(t.id, t);
    } catch { /* an unreadable old file is simply rebuilt */ }
  }
  return previous;
}

/**
 * @returns {Promise<Map<string, {region, builtAt, titles}>>} one entry per country that has a usable catalog
 */
export async function buildCatalogs({ tmdb, regions, previous = new Map(), now = Date.now(), maxAgeDays = 14, ratings = imdbRatings, log = () => {} }) {
  const refsByRegion = new Map();
  for (const region of regions) {
    try {
      const refs = await discoverRefs(tmdb, region);
      if (refs.length < MIN_NETFLIX_TITLES) log(`${region}: only ${refs.length} titles, skipping`);
      else refsByRegion.set(region, refs);
    } catch (err) {
      log(`${region}: ${err.message}, skipping`);
    }
  }

  // Titles are shared between countries, so each one is fetched once.
  const wanted = new Map();
  for (const refs of refsByRegion.values()) for (const r of refs) wanted.set(idOf(r), r);
  const titles = new Map();
  const todo = [];
  for (const [id, ref] of wanted) {
    const old = previous.get(id);
    if (old?.fetchedAt && now - old.fetchedAt < maxAgeDays * DAY) titles.set(id, old);
    else todo.push(ref);
  }
  log(`${wanted.size} titles across ${refsByRegion.size} countries (${titles.size} reused, ${todo.length} to fetch)`);
  for (let i = 0; i < todo.length; i += 400) {
    for (const t of await fetchTitles(tmdb, todo.slice(i, i + 400))) { t.fetchedAt = now; titles.set(t.id, t); }
    log(`  fetched ${Math.min(todo.length, i + 400)} / ${todo.length}`);
  }

  try {
    const found = await ratings([...titles.values()].map((t) => t.imdbId).filter(Boolean));
    applyRatings([...titles.values()], Object.fromEntries(found));
    log(`IMDb ratings for ${found.size} titles`);
  } catch (err) {
    log(`IMDb ratings unavailable (${err.message}); keeping earlier ratings, TMDB scores for the rest`);
  }

  const catalogs = new Map();
  for (const [region, refs] of refsByRegion) {
    const scores = await fetchTrending(tmdb, region).catch(() => ({}));
    // a copy per country, because "trending" differs between countries
    const list = applyTrending(refs.map((r) => titles.get(idOf(r))).filter(Boolean).map((t) => ({ ...t, onNetflix: true })), scores);
    if (list.length >= MIN_NETFLIX_TITLES) catalogs.set(region, { region, builtAt: now, titles: list });
  }
  return catalogs;
}

/** Writes catalog/<COUNTRY>.json.gz and index.json. Countries that were not rebuilt keep their old file. */
export function writeCatalogs(dir, catalogs, now = Date.now()) {
  const folder = path.join(dir, 'catalog');
  fs.mkdirSync(folder, { recursive: true });
  for (const [region, catalog] of catalogs) {
    fs.writeFileSync(path.join(folder, `${region}.json.gz`), zlib.gzipSync(JSON.stringify(catalog), { level: 9 }));
  }
  let earlier = {};
  try { earlier = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).regions || {}; } catch { /* first run */ }
  const index = { builtAt: now, regions: {} };
  for (const file of fs.readdirSync(folder).filter((f) => f.endsWith('.json.gz'))) {
    const region = file.slice(0, 2);
    const c = catalogs.get(region);
    index.regions[region] = c ? { count: c.titles.length, builtAt: c.builtAt } : (earlier[region] || {});
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
}

async function main() {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error('Set TMDB_API_KEY (get a free one at https://www.themoviedb.org/settings/api)');
  const dir = path.resolve(process.env.OUT_DIR || 'data-out');
  const regions = (process.env.REGIONS || Object.keys(REGIONS).join(',')).split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
  const tmdb = createTmdb(key, undefined, process.env.TMDB_BASE || undefined);
  const imdbUrl = process.env.IMDB_URL || undefined;
  const now = Date.now();
  const catalogs = await buildCatalogs({
    tmdb, regions, previous: readPrevious(dir), now, log: (m) => console.log(m),
    ratings: (ids) => imdbRatings(ids, { url: imdbUrl }),
  });
  if (!catalogs.size) throw new Error('No catalog could be built, so nothing was written');
  writeCatalogs(dir, catalogs, now);
  console.log(`Wrote ${catalogs.size} catalogs to ${dir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err.message); process.exit(1); });
