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

/** Two lookups in one: the country's catalog first, then titles the person watched that are not in it. */
const layered = (a, b) => ({ get: (id) => a.get(id) ?? b.get(id), has: (id) => a.has(id) || b.has(id) });

/**
 * Everything the engine needs, from the catalog and the person's data:
 * data = {settings: {includeWatched, types, minRating}, swipes: [{id, action, at}],
 *         history: {groups: [{name, kind, views, lastWatched, titleId?}], titles: {id: compactTitle}} | null}
 */
export function makeContext(catalog, data) {
  const groups = data.history?.groups || [];
  const extras = new Map(Object.entries(data.history?.titles || {}));
  const byId = layered(catalog.byId, extras);
  const byName = resolveByTitle(groups, catalog.titles); // fallback when a group has no stored match yet
  const resolved = groups.map((g, i) => ({ ...g, titleId: g.titleId && byId.has(g.titleId) ? g.titleId : byName[i].titleId }));
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

/** Titles liked or marked must-watch, newest first. */
export function likes(catalog, data) {
  const { ctx, swipes } = makeContext(catalog, data);
  return swipes.filter((s) => s.action !== 'nope' && catalog.byId.has(s.id)).reverse()
    .map((s) => ({ ...cardFor(ctx, catalog.byId.get(s.id)), action: s.action, at: s.at }));
}

export function cards(catalog, data, ids) {
  const { ctx } = makeContext(catalog, data);
  return ids.filter((id) => catalog.byId.has(id)).map((id) => cardFor(ctx, catalog.byId.get(id)));
}

/** History groups the phone could not match on its own: these are worth a lookup. */
export function unmatchedGroups(catalog, data) {
  const { resolved } = makeContext(catalog, data);
  return (data.history?.groups || []).filter((_, i) => !resolved[i].titleId);
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
    stats: { likes: count('like'), supers: count('super'), nopes: count('nope'), remaining: ctx.catalog.length - ctx.swipedIds.size },
    taste: topTastes(ctx.profile),
  };
}
