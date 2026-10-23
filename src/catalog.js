// Builds the swipeable catalog: what's on Netflix in your region (via TMDB) +
// IMDb ratings, or the bundled demo catalog when no TMDB key is configured.
import fs from 'node:fs';
import { createTmdb, fetchDetails, mapLimit, NETFLIX_PROVIDER_ID } from './tmdb.js';
import { imdbRatings } from './imdb.js';
import { normalizeTitle } from './history.js';
import { readCache, writeCache } from './store.js';

const MAX_AGE = 7 * 86400000;
const HISTORY_LIMIT = 300; // most recently watched shows/movies to look up

export const netflixUrl = (title) => `https://www.netflix.com/search?q=${encodeURIComponent(title)}`;

export function loadDemoCatalog() {
  const raw = JSON.parse(fs.readFileSync(new URL('../data/demo-catalog.json', import.meta.url), 'utf8'));
  return raw.titles.map((t) => ({ ...t, netflixUrl: netflixUrl(t.title) }));
}

/** Matches history groups to catalog titles by (alternative) title. */
export function resolveByTitle(groups, titles) {
  const index = new Map();
  for (const t of titles) {
    for (const name of [t.title, ...(t.aka || [])]) {
      const key = normalizeTitle(name);
      if (!index.has(key)) index.set(key, t);
    }
  }
  return groups.map((g) => {
    const t = index.get(normalizeTitle(g.name));
    return { ...g, titleId: t && (g.kind !== 'series' || t.type === 'series') ? t.id : null };
  });
}

function bestMatch(results, name) {
  const want = normalizeTitle(name);
  const exact = results.find((r) => [r.title, r.name, r.original_title, r.original_name].some((n) => n && normalizeTitle(n) === want));
  return exact || results[0] || null;
}

async function discover(tmdb, region, onProgress) {
  const lists = [];
  for (const kind of ['movie', 'tv']) {
    for (let page = 1; page <= 12; page++) lists.push({ kind, page, sort_by: 'popularity.desc' });
    for (let page = 1; page <= 8; page++) lists.push({ kind, page, sort_by: 'vote_average.desc', 'vote_count.gte': kind === 'movie' ? 500 : 200 });
  }
  const seen = new Map();
  let done = 0;
  await mapLimit(lists, 6, async ({ kind, ...params }) => {
    const res = await tmdb.get(`/discover/${kind}`, {
      ...params,
      watch_region: region,
      with_watch_providers: NETFLIX_PROVIDER_ID,
      with_watch_monetization_types: 'flatrate',
      language: 'en-US',
    });
    for (const r of res.results || []) seen.set(`${kind}:${r.id}`, { kind, id: r.id });
    onProgress?.(`Finding what's on Netflix ${region}…`, (++done / lists.length) * 0.3);
  });
  return [...seen.values()];
}

async function attachRatings(titles) {
  const need = titles.filter((t) => t.imdbId && t.imdbRating == null).map((t) => t.imdbId);
  if (!need.length) return;
  try {
    const ratings = await imdbRatings(need);
    for (const t of titles) {
      const r = ratings.get(t.imdbId);
      if (r) { t.imdbRating = r.rating; t.imdbVotes = r.votes; }
    }
  } catch (err) {
    console.warn(`IMDb ratings unavailable (${err.message}); falling back to TMDB scores`);
  }
}

/**
 * Matches watch-history groups to TMDB titles (shared cache, so the first person to
 * watch something pays for the lookup and everyone after gets it free). Titles that are
 * not in `knownIds` (watched, but not on Netflix now) are fetched so they can still
 * shape your taste. Returns {ids: [titleId|null per group], extra: [titles]}.
 */
export async function resolveHistory({ key, groups, knownIds = new Set(), onProgress, rate = true }) {
  const tmdb = createTmdb(key);
  const searchCache = readCache('tmdb-search.json') || {};
  let done = 0;
  const ids = await mapLimit(groups, 6, async (g) => {
    const kind = g.kind === 'series' ? 'tv' : 'movie';
    const cacheKey = `${kind}|${normalizeTitle(g.name)}`;
    if (!(cacheKey in searchCache)) {
      let res = await tmdb.get(`/search/${kind}`, { query: g.name });
      let hit = bestMatch(res.results || [], g.name);
      let hitKind = kind;
      if (!hit) {
        res = await tmdb.get('/search/multi', { query: g.name });
        hit = bestMatch((res.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv'), g.name);
        hitKind = hit?.media_type;
      }
      searchCache[cacheKey] = hit ? { kind: hitKind, id: hit.id } : null;
    }
    onProgress?.('Matching your viewing history…', ++done / Math.max(1, groups.length));
    const hit = searchCache[cacheKey];
    return hit ? `tmdb-${hit.kind}-${hit.id}` : null;
  });
  writeCache('tmdb-search.json', searchCache);

  const missing = [...new Set(ids.filter((id) => id && !knownIds.has(id)))];
  const extra = (await mapLimit(missing, 8, (id) => {
    const [, kind, tmdbId] = id.split('-');
    return fetchDetails(tmdb, kind, tmdbId);
  })).filter(Boolean);
  for (const t of extra) { t.onNetflix = false; t.netflixUrl = netflixUrl(t.title); }
  if (rate) await attachRatings(extra);
  if (extra.length) {
    const known = new Map((readCache('history-titles.json') || []).map((t) => [t.id, t]));
    for (const t of extra) known.set(t.id, t);
    writeCache('history-titles.json', [...known.values()]);
  }
  return { ids, extra };
}

/**
 * Full TMDB build of one region's Netflix catalog (cached for a week).
 * `groups` is optional: when given, the history is resolved in the same pass.
 */
export async function buildTmdbCatalog({ key, region, groups = [], force = false, onProgress }) {
  const tmdb = createTmdb(key);
  const cacheName = `catalog-${region}.json`;
  let cached = force ? null : readCache(cacheName);
  if (cached && Date.now() - cached.builtAt > MAX_AGE) cached = null;

  let titles = cached?.titles;
  if (!titles) {
    const refs = await discover(tmdb, region, onProgress);
    let done = 0;
    titles = (await mapLimit(refs, 8, async ({ kind, id }) => {
      const t = await fetchDetails(tmdb, kind, id);
      onProgress?.('Reading titles, cast and keywords…', 0.3 + (++done / refs.length) * 0.45);
      return t;
    })).filter(Boolean);
    titles.forEach((t) => { t.onNetflix = true; });
  }

  const recent = groups.slice(0, HISTORY_LIMIT);
  const { ids, extra } = recent.length
    ? await resolveHistory({ key, groups: recent, knownIds: new Set(titles.map((t) => t.id)), rate: false })
    : { ids: [], extra: [] };
  const all = titles.concat(extra.filter((t) => !titles.some((x) => x.id === t.id)));

  onProgress?.('Adding IMDb ratings…', 0.92);
  await attachRatings(all);
  for (const t of all) t.netflixUrl = netflixUrl(t.title);

  writeCache(cacheName, { builtAt: cached?.builtAt || Date.now(), region, titles: all.filter((t) => t.onNetflix) });
  if (extra.length) {
    const known = new Map((readCache('history-titles.json') || []).map((t) => [t.id, t]));
    for (const t of extra) known.set(t.id, t);
    writeCache('history-titles.json', [...known.values()]);
  }

  const resolvedGroups = groups.map((g, i) => ({ ...g, titleId: i < recent.length ? ids[i] : g.titleId ?? null }));
  return { titles: all, groups: resolvedGroups };
}

const TRENDING_MAX_AGE = 24 * 3600000;

/**
 * "Hot right now" signal per title id, 0..1. Combines TMDB's daily trending
 * list with Netflix-only popularity for the region, so something that is both
 * trending worldwide and popular on Netflix ranks highest.
 */
export async function fetchTrending(tmdb, region) {
  const scores = {};
  const bump = (kind, id, value) => {
    const key = `tmdb-${kind}-${id}`;
    scores[key] = Math.max(scores[key] || 0, value);
  };
  for (const kind of ['movie', 'tv']) {
    const pages = [1, 2];
    const trending = await mapLimit(pages, 2, (page) => tmdb.get(`/trending/${kind}/day`, { page }));
    const list = trending.flatMap((r) => r?.results || []);
    list.forEach((r, i) => bump(kind, r.id, 1 - i / Math.max(1, list.length)));
    const popular = await mapLimit(pages, 2, (page) => tmdb.get(`/discover/${kind}`, {
      page, sort_by: 'popularity.desc', watch_region: region, with_watch_providers: NETFLIX_PROVIDER_ID,
      with_watch_monetization_types: 'flatrate', language: 'en-US',
    }));
    const hot = popular.flatMap((r) => r?.results || []);
    hot.forEach((r, i) => bump(kind, r.id, 0.8 * (1 - i / Math.max(1, hot.length))));
  }
  return scores;
}

/** Writes `trend` (0..1) onto titles; titles that aren't trending get 0. Mutates and returns titles. */
export function applyTrending(titles, scores) {
  for (const t of titles) t.trend = scores?.[t.id] || 0;
  return titles;
}

/** Cached trending scores for a region, or null when missing/older than a day. */
export function cachedTrending(region, now = Date.now()) {
  const c = readCache(`trending-${region}.json`);
  return c && now - c.at < TRENDING_MAX_AGE ? c.scores : null;
}

/** Refreshes the daily trending cache if it is stale. Returns the scores, or null if it could not be fetched. */
export async function refreshTrending({ key, region, force = false, fetchImpl }) {
  if (!force) {
    const fresh = cachedTrending(region);
    if (fresh) return fresh;
  }
  try {
    const scores = await fetchTrending(createTmdb(key, fetchImpl), region);
    writeCache(`trending-${region}.json`, { at: Date.now(), region, scores });
    return scores;
  } catch (err) {
    console.warn(`Trending unavailable (${err.message})`);
    const stale = readCache(`trending-${region}.json`);
    return stale?.scores || null;
  }
}

/** Cached TMDB catalog for a region (plus looked-up history titles), or null. */
export function cachedTmdbCatalog(region) {
  const c = readCache(`catalog-${region}.json`);
  if (!c) return null;
  const extra = readCache('history-titles.json') || [];
  const ids = new Set(c.titles.map((t) => t.id));
  return { builtAt: c.builtAt, titles: c.titles.concat(extra.filter((t) => !ids.has(t.id))) };
}
