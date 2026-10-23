// The Movie Database (TMDB) client. Free API key: https://www.themoviedb.org/settings/api
// Used for "what is on Netflix in my country" (watch provider 8) plus posters,
// keywords and cast. Accepts either a v3 API key or a v4 read access token.

export const NETFLIX_PROVIDER_ID = 8;
const IMG = 'https://image.tmdb.org/t/p/';

export function createTmdb(key, fetchImpl = fetch, base = 'https://api.themoviedb.org/3') {
  const bearer = key.length > 40;
  async function get(path, params = {}) {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    if (!bearer) url.searchParams.set('api_key', key);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { headers: bearer ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' } });
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * (Number(res.headers.get('retry-after')) || attempt + 1)));
        continue;
      }
      if (res.status === 401) throw new Error('TMDB rejected the API key');
      if (!res.ok) throw new Error(`TMDB ${path} failed (${res.status})`);
      return res.json();
    }
  }
  return { get };
}

/** Runs fn over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  }));
  return out;
}

export function mapDetails(kind, d) {
  const isMovie = kind === 'movie';
  const date = isMovie ? d.release_date : d.first_air_date;
  const keywords = (isMovie ? d.keywords?.keywords : d.keywords?.results) || [];
  const credits = isMovie ? d.credits : d.aggregate_credits || d.credits;
  const creators = isMovie
    ? (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name)
    : (d.created_by || []).map((c) => c.name);
  return {
    id: `tmdb-${kind}-${d.id}`,
    tmdbId: d.id,
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    type: isMovie ? 'movie' : 'series',
    title: isMovie ? d.title : d.name,
    aka: [isMovie ? d.original_title : d.original_name].filter((x) => x && x !== (isMovie ? d.title : d.name)),
    year: date ? Number(date.slice(0, 4)) : null,
    endYear: !isMovie && d.last_air_date && d.status === 'Ended' ? Number(d.last_air_date.slice(0, 4)) : null,
    runtime: isMovie ? d.runtime || null : d.episode_run_time?.[0] || null,
    seasons: isMovie ? null : d.number_of_seasons || null,
    genres: (d.genres || []).map((g) => g.name),
    keywords: keywords.slice(0, 15).map((k) => k.name),
    cast: (credits?.cast || []).slice(0, 6).map((c) => c.name),
    creators: creators.slice(0, 3),
    language: d.original_language || null,
    overview: d.overview || '',
    tagline: d.tagline || '',
    poster: d.poster_path ? `${IMG}w780${d.poster_path}` : null,
    backdrop: d.backdrop_path ? `${IMG}w1280${d.backdrop_path}` : null,
    tmdbRating: d.vote_average || null,
    popularity: d.popularity || 0,
  };
}

export function fetchDetails(tmdb, kind, id) {
  const append = kind === 'movie' ? 'keywords,credits,external_ids' : 'keywords,aggregate_credits,external_ids';
  return tmdb.get(`/${kind}/${id}`, { append_to_response: append }).then((d) => mapDetails(kind, d));
}
