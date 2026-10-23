// Builds the swipeable catalog: what's on Netflix in a region (via TMDB) plus IMDb ratings.
// Everything here is storage-free so it runs in a Cloudflare Worker, a Workflow, or a Node test.
import { fetchDetails, mapLimit, NETFLIX_PROVIDER_ID } from './tmdb.js';

export { netflixUrl, resolveByTitle } from '../public/lib/match.js';
import { netflixUrl } from '../public/lib/match.js';

/** A real catalog needs at least this many Netflix titles; fewer means TMDB has nothing for that country. */
export const MIN_NETFLIX_TITLES = 20;

const KEYWORD_QUERIES = {
  standup: ['stand-up comedy', 'stand up comedy', 'standup comedy', 'stand-up comedian'],
  concert: ['concert', 'concert film', 'live concert', 'live music', 'music festival'],
};
const MUSIC_GENRE = 10402;

/**
 * TMDB keyword ids for stand-up comedy and concerts ("9716|1997|..."). The general lists are dominated by
 * blockbusters, so without asking for these by name they would almost never appear in anyone's deck.
 */
export async function formatKeywordIds(tmdb) {
  const out = {};
  for (const [format, names] of Object.entries(KEYWORD_QUERIES)) {
    const ids = new Set();
    for (const name of names) {
      const res = await tmdb.get('/search/keyword', { query: name }).catch(() => ({ results: [] }));
      for (const k of res.results || []) if (k.name?.toLowerCase() === name) ids.add(k.id);
    }
    out[format] = [...ids].join('|');
  }
  return out;
}

/** The lists to read: what is popular and well rated, plus stand-up specials and concerts asked for by name. */
function discoverLists(sizes, formats) {
  const lists = [];
  for (const kind of ['movie', 'tv']) {
    for (let page = 1; page <= sizes.popular[kind]; page++) lists.push({ kind, page, sort_by: 'popularity.desc' });
    for (let page = 1; page <= sizes.top[kind]; page++) lists.push({ kind, page, sort_by: 'vote_average.desc', 'vote_count.gte': kind === 'movie' ? 500 : 200 });
  }
  for (const [format, keywords] of Object.entries(formats)) {
    if (!keywords) continue;
    for (let page = 1; page <= sizes.format; page++) lists.push({ kind: 'movie', page, sort_by: 'popularity.desc', with_keywords: keywords });
    for (let page = 1; page <= 3; page++) lists.push({ kind: 'movie', page, sort_by: 'vote_average.desc', 'vote_count.gte': 30, with_keywords: keywords });
    if (format === 'standup') for (let page = 1; page <= 2; page++) lists.push({ kind: 'tv', page, sort_by: 'popularity.desc', with_keywords: keywords });
  }
  for (let page = 1; page <= Math.ceil(sizes.format / 2); page++) lists.push({ kind: 'movie', page, sort_by: 'popularity.desc', with_genres: MUSIC_GENRE });
  return lists;
}

async function runLists(tmdb, lists, extra, onProgress, label) {
  const seen = new Map();
  let done = 0;
  await mapLimit(lists, 6, async ({ kind, ...params }) => {
    const res = await tmdb.get(`/discover/${kind}`, { ...params, ...extra, language: 'en-US' });
    for (const r of res.results || []) seen.set(`${kind}:${r.id}`, { kind, id: r.id });
    onProgress?.(label, (++done / lists.length) * 0.3);
  });
  return [...seen.values()];
}

/** [{kind, id}] of everything TMDB lists as streaming on Netflix in `region`, including stand-up and concerts. */
export async function discoverRefs(tmdb, region, onProgress, formats) {
  formats ||= await formatKeywordIds(tmdb);
  const lists = discoverLists({ popular: { movie: 12, tv: 12 }, top: { movie: 8, tv: 8 }, format: 6 }, formats);
  return runLists(tmdb, lists, { watch_region: region, with_watch_providers: NETFLIX_PROVIDER_ID, with_watch_monetization_types: 'flatrate' },
    onProgress, `Finding what's on Netflix ${region}…`);
}

/** [{kind, id}] of popular and well-rated titles anywhere, for people who also watch on other services or IPTV. */
export async function discoverAnywhere(tmdb, onProgress, formats) {
  formats ||= await formatKeywordIds(tmdb);
  const lists = discoverLists({ popular: { movie: 15, tv: 10 }, top: { movie: 10, tv: 6 }, format: 6 }, formats);
  return runLists(tmdb, lists, {}, onProgress, 'Finding popular titles…');
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
