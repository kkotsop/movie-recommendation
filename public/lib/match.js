// Matching a person's Netflix history to catalog titles. Runs on the phone and in tests.
import { normalizeTitle } from './history.js';

export const netflixUrl = (title) => `https://www.netflix.com/search?q=${encodeURIComponent(title)}`;

/** Matches history groups to catalog titles by (alternative) title. Returns the groups with a `titleId` (or null). */
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

/**
 * The few fields the recommender needs about a title the phone keeps for itself
 * (watched, but not in the catalog). Small enough to store hundreds of them.
 */
export function compactTitle(t) {
  return {
    id: t.id, type: t.type, title: t.title, aka: t.aka || [], year: t.year ?? null,
    genres: t.genres || [], keywords: (t.keywords || []).slice(0, 15), creators: (t.creators || []).slice(0, 3),
    cast: (t.cast || []).slice(0, 5), language: t.language ?? null, imdbRating: t.imdbRating ?? null,
    tmdbRating: t.tmdbRating ?? null, onNetflix: false,
  };
}
