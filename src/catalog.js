// Builds the swipeable catalog: what's on Netflix in a region (via TMDB) plus IMDb ratings.
// Everything here is storage-free so it runs in a Cloudflare Worker, a Workflow, or a Node test.
import { fetchDetails, mapLimit, NETFLIX_PROVIDER_ID } from './tmdb.js';
import { normalizeTitle } from '../public/lib/history.js';

export { netflixUrl, resolveByTitle } from '../public/lib/match.js';
import { netflixUrl } from '../public/lib/match.js';

/** A real catalog needs at least this many Netflix titles; fewer means TMDB has nothing for that country. */
export const MIN_NETFLIX_TITLES = 20;

function bestMatch(results, name) {
  const want = normalizeTitle(name);
  const exact = results.find((r) => [r.title, r.name, r.original_title, r.original_name].some((n) => n && normalizeTitle(n) === want));
  return exact || results[0] || null;
}

/** [{kind, id}] of everything TMDB lists as streaming on Netflix in `region`. */
export async function discoverRefs(tmdb, region, onProgress) {
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

/** Full details (cast, keywords, ...) for a batch of {kind, id} refs. Failed lookups are skipped. */
export async function fetchTitles(tmdb, refs) {
  const titles = (await mapLimit(refs, 8, ({ kind, id }) => fetchDetails(tmdb, kind, id))).filter(Boolean);
  for (const t of titles) { t.onNetflix = true; t.netflixUrl = netflixUrl(t.title); }
  return titles;
}

/** Copies IMDb ratings ({imdbId: {rating, votes}}) onto titles. */
export function applyRatings(titles, ratings) {
  for (const t of titles) {
    const r = ratings?.[t.imdbId];
    if (r) { t.imdbRating = r.rating; t.imdbVotes = r.votes; }
  }
  return titles;
}

/**
 * Matches watch-history groups to TMDB titles. `shared` is the cache every person uses
 * ({getSearch(keys), putSearch(obj), getTitles(ids), putTitles(titles)}), so the first person to
 * watch something pays for the lookup and everyone after gets it free. Titles that are not in
 * `knownIds` (watched, but not on Netflix now) are fetched so they can still shape taste.
 * Returns the TMDB title id (or null) for each group, in order.
 */
export async function resolveHistory({ tmdb, groups, knownIds = new Set(), shared }) {
  const keyOf = (g) => `${g.kind === 'series' ? 'tv' : 'movie'}|${normalizeTitle(g.name)}`;
  const cache = await shared.getSearch([...new Set(groups.map(keyOf))]);
  const fresh = {};
  const ids = await mapLimit(groups, 6, async (g) => {
    const key = keyOf(g);
    if (!(key in cache) && !(key in fresh)) {
      const kind = g.kind === 'series' ? 'tv' : 'movie';
      let res = await tmdb.get(`/search/${kind}`, { query: g.name });
      let hit = bestMatch(res.results || [], g.name);
      let hitKind = kind;
      if (!hit) {
        res = await tmdb.get('/search/multi', { query: g.name });
        hit = bestMatch((res.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv'), g.name);
        hitKind = hit?.media_type;
      }
      fresh[key] = hit ? { kind: hitKind, id: hit.id } : null;
    }
    const hit = key in cache ? cache[key] : fresh[key];
    return hit ? `tmdb-${hit.kind}-${hit.id}` : null;
  });
  if (Object.keys(fresh).length) await shared.putSearch(fresh);

  const missing = [...new Set(ids.filter((id) => id && !knownIds.has(id)))];
  if (missing.length) {
    const have = new Set((await shared.getTitles(missing)).map((t) => t.id));
    const todo = missing.filter((id) => !have.has(id));
    const extra = (await mapLimit(todo, 8, (id) => {
      const [, kind, tmdbId] = id.split('-');
      return fetchDetails(tmdb, kind, tmdbId);
    })).filter(Boolean);
    for (const t of extra) { t.onNetflix = false; t.netflixUrl = netflixUrl(t.title); }
    if (extra.length) await shared.putTitles(extra);
  }
  return ids;
}

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
