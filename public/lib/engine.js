// The recommendation engine. It runs on the phone, on the person's own data, so nothing about their
// history or swipes ever has to leave the device. The same code runs in the tests.
import { buildProfile, nextDeck, feelingLucky, dailyPicks, topTastes, explain } from './recommender.js';
import { resolveByTitle, netflixUrl } from './match.js';

export const netflixCount = (c) => c.titles.filter((t) => t.onNetflix !== false).length;

export function makeCatalog(source, titles, builtAt = null) {
  return { source, titles, byId: new Map(titles.map((t) => [t.id, t])), builtAt };
}

/** The built-in sample (public/demo-catalog.json), used until a country's full catalog is available. */
export function demoCatalog(raw) {
  return makeCatalog('demo', raw.titles.map((t) => ({ ...t, netflixUrl: netflixUrl(t.title) })));
}

/**
 * A country's catalog plus the worldwide one (titles from other services or IPTV). Titles on Netflix keep their
 * Netflix entry; the rest are marked as not on Netflix and only shown when the person asks for titles from anywhere.
 */
export function mergeCatalogs(region, all) {
  if (!all) return region;
  const have = new Set(region.titles.map((t) => t.imdbId).filter(Boolean));
  const extra = all.titles.filter((t) => !region.byId.has(t.id) && !(t.imdbId && have.has(t.imdbId)));
  return { ...makeCatalog(region.source, [...region.titles, ...extra], region.builtAt), hasWorldwide: true };
}

/**
 * Everything the engine needs, from the catalog and the person's data:
 * data = {settings: {includeWatched, types, minRating, anywhere}, swipes: [{id, action, at}],
 *         history: {groups: [{name, kind, views, lastWatched}]} | null}
 */
export function makeContext(catalog, data) {
  const groups = data.history?.groups || [];
  const byId = catalog.byId;
  const resolved = resolveByTitle(groups, catalog.titles);
  const watched = resolved.filter((g) => g.titleId);
  // A swipe on the built-in sample ("imdb-tt123") still counts once the country's real catalog replaces it.
  const byImdb = new Map(catalog.titles.filter((t) => t.imdbId).map((t) => [t.imdbId, t.id]));
  const swipes = (data.swipes || [])
    .map((s) => (byId.has(s.id) ? s : { ...s, id: s.id.startsWith('imdb-') ? byImdb.get(s.id.slice(5)) : undefined }))
    .filter((s) => s.id && byId.has(s.id));
  return {
    resolved, swipes,
    ctx: {
      catalog: catalog.titles,
      profile: buildProfile({ byId, watched, swipes }),
      swipedIds: new Set(swipes.map((s) => s.id)),
      watchedIds: new Set(watched.map((g) => g.titleId)),
      settings: data.settings,
    },
  };
}

const cardFor = (c, t) => ({ ...t, watched: c.watchedIds.has(t.id), reason: explain(c.profile, t) });

export function deck(catalog, data, { exclude = [], n = 10, rng } = {}) {
  const { ctx } = makeContext(catalog, data);
  return nextDeck({ ...ctx, excludeIds: new Set(exclude), n: Math.max(1, Math.min(30, n)), ...(rng ? { rng } : {}) });
}

export function lucky(catalog, data, { exclude = [], rng } = {}) {
  const { ctx } = makeContext(catalog, data);
  return feelingLucky({ ...ctx, excludeIds: new Set(exclude), ...(rng ? { rng } : {}) });
}

/** Same list all day (seeded by the local date `YYYY-MM-DD`), a new one tomorrow. */
export function daily(catalog, data, date) {
  const { ctx } = makeContext(catalog, data);
  return dailyPicks({ ...ctx, excludeIds: new Set(), date });
}

/** Titles liked, marked must-watch or saved for later, newest first. */
export function likes(catalog, data) {
  const { ctx, swipes } = makeContext(catalog, data);
  return swipes.filter((s) => s.action !== 'nope' && catalog.byId.has(s.id)).reverse()
    .map((s) => ({ ...cardFor(ctx, catalog.byId.get(s.id)), action: s.action, at: s.at }));
}

export function cards(catalog, data, ids) {
  const { ctx } = makeContext(catalog, data);
  return ids.filter((id) => catalog.byId.has(id)).map((id) => cardFor(ctx, catalog.byId.get(id)));
}

/** Summary for the Profile tab and the badges. */
export function profile(catalog, data) {
  const { ctx, resolved } = makeContext(catalog, data);
  const count = (a) => (data.swipes || []).filter((s) => s.action === a).length;
  const h = data.history;
  return {
    catalog: { source: catalog.source, count: netflixCount(catalog), builtAt: catalog.builtAt },
    history: h?.groups?.length ? {
      source: h.source, importedAt: h.importedAt, entries: h.entries, titles: h.groups.length,
      matched: resolved.filter((g) => g.titleId).length,
      recent: resolved.slice(0, 12).map((g) => ({ name: g.name, kind: g.kind, views: g.views, lastWatched: g.lastWatched, matched: Boolean(g.titleId) })),
    } : null,
    stats: { likes: count('like'), supers: count('super'), later: count('later'), nopes: count('nope'), remaining: ctx.catalog.length - ctx.swipedIds.size },
    taste: topTastes(ctx.profile),
  };
}
