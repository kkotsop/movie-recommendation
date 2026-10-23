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

/**
 * Full TMDB build. Returns {titles, groups} where groups carry the resolved
 * titleId. Discover results are cached per region for a week.
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

  // Look up what you watched (it may have left Netflix; it still shapes your taste).
  const searchCache = readCache('tmdb-search.json') || {};
  const recent = groups.slice(0, HISTORY_LIMIT);
  let done = 0;
  const resolvedIds = await mapLimit(recent, 6, async (g) => {
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
    onProgress?.('Matching your viewing history…', 0.75 + (++done / Math.max(1, recent.length)) * 0.15);
    const hit = searchCache[cacheKey];
    return hit ? `tmdb-${hit.kind}-${hit.id}` : null;
  });
  writeCache('tmdb-search.json', searchCache);

  const byId = new Map(titles.map((t) => [t.id, t]));
  const missing = [...new Set(resolvedIds.filter((id) => id && !byId.has(id)))];
  const extra = (await mapLimit(missing, 8, (id) => {
    const [, kind, tmdbId] = id.split('-');
    return fetchDetails(tmdb, kind, tmdbId);
  })).filter(Boolean);
  for (const t of extra) { t.onNetflix = false; byId.set(t.id, t); }
  titles = [...byId.values()];

  onProgress?.('Adding IMDb ratings…', 0.92);
  const needRating = titles.filter((t) => t.imdbId && t.imdbRating == null).map((t) => t.imdbId);
  try {
    const ratings = needRating.length ? await imdbRatings(needRating) : new Map();
    for (const t of titles) {
      const r = ratings.get(t.imdbId);
      if (r) { t.imdbRating = r.rating; t.imdbVotes = r.votes; }
    }
  } catch (err) {
    console.warn(`IMDb ratings unavailable (${err.message}); falling back to TMDB scores`);
  }
  for (const t of titles) t.netflixUrl = netflixUrl(t.title);

  writeCache(cacheName, { builtAt: cached?.builtAt || Date.now(), region, titles: titles.filter((t) => t.onNetflix) });
  const historyTitles = new Map((readCache('history-titles.json') || []).map((t) => [t.id, t]));
  for (const t of titles) if (!t.onNetflix) historyTitles.set(t.id, t);
  writeCache('history-titles.json', [...historyTitles.values()]);

  const resolvedGroups = groups.map((g, i) => ({ ...g, titleId: i < recent.length ? resolvedIds[i] : g.titleId ?? null }));
  return { titles, groups: resolvedGroups };
}

/** Cached TMDB catalog for a region (plus looked-up history titles), or null. */
export function cachedTmdbCatalog(region) {
  const c = readCache(`catalog-${region}.json`);
  if (!c) return null;
  const extra = readCache('history-titles.json') || [];
  const ids = new Set(c.titles.map((t) => t.id));
  return { builtAt: c.builtAt, titles: c.titles.concat(extra.filter((t) => !ids.has(t.id))) };
}
