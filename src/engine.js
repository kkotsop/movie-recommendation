// The app's API as plain functions, shared by the local Node server and the
// in-browser (static hosting) build. No Node or browser APIs in here.
//
// host = {
//   state,                      // mutable app state (see store.js); host.state may be reassigned
//   catalog,                    // {source, titles, byId, builtAt}
//   jobs,                       // background job status shown in the UI
//   capabilities,               // {netflixLogin, tmdb}
//   save(),                     // persist host.state
//   afterHistoryImport?(),      // e.g. rebuild the TMDB catalog
//   afterSettings?(changes),    // changes: {catalogChanged}
//   resetAll?(),                // scope "all": return a fresh state
// }
import { parseViewingHistoryCsv, entriesFromRows, groupHistory, resolveByTitle } from './history.js';
import { buildProfile, nextDeck, feelingLucky, topTastes, explain } from './recommender.js';

const ids = (q) => new Set((q.get('exclude') || '').split(',').filter(Boolean));

export function createEngine(host) {
  /** History groups with titleId pointing into the current catalog. */
  function resolvedHistory() {
    const groups = host.state.history?.groups || [];
    const byTitle = resolveByTitle(groups, host.catalog.titles);
    return groups.map((g, i) => {
      const stored = host.catalog.source === 'tmdb' && g.titleId && host.catalog.byId.has(g.titleId) ? g.titleId : null;
      return { ...g, titleId: stored || byTitle[i].titleId };
    });
  }

  function context() {
    const { catalog, state } = host;
    const watched = resolvedHistory().filter((g) => g.titleId);
    const swipes = state.swipes.filter((s) => catalog.byId.has(s.id));
    return {
      catalog: catalog.titles,
      profile: buildProfile({ byId: catalog.byId, watched, swipes }),
      swipedIds: new Set(swipes.map((s) => s.id)),
      watchedIds: new Set(watched.map((g) => g.titleId)),
      settings: state.settings,
    };
  }

  const cardFor = (ctx, t) => ({ ...t, watched: ctx.watchedIds.has(t.id), reason: explain(ctx.profile, t) });

  function publicState() {
    const { state, catalog } = host;
    const ctx = context();
    const watched = resolvedHistory();
    const count = (a) => state.swipes.filter((s) => s.action === a).length;
    const { tmdbKey, ...settings } = state.settings;
    return {
      settings: { ...settings, hasTmdbKey: Boolean(tmdbKey) },
      onboarded: state.onboarded,
      capabilities: host.capabilities,
      catalog: { source: catalog.source, count: catalog.titles.filter((t) => t.onNetflix !== false).length, builtAt: catalog.builtAt },
      history: state.history && {
        source: state.history.source,
        importedAt: state.history.importedAt,
        entries: state.history.entries,
        titles: state.history.groups.length,
        matched: watched.filter((g) => g.titleId).length,
        recent: watched.slice(0, 12).map((g) => ({ name: g.name, kind: g.kind, views: g.views, lastWatched: g.lastWatched, matched: Boolean(g.titleId) })),
      },
      stats: { likes: count('like'), supers: count('super'), nopes: count('nope'), remaining: ctx.catalog.length - ctx.swipedIds.size },
      taste: topTastes(ctx.profile),
      jobs: host.jobs,
    };
  }

  function importHistory(entries, source) {
    const { state } = host;
    const previous = new Map((state.history?.groups || []).map((g) => [g.name, g.titleId]));
    const groups = groupHistory(entries).map((g) => ({ ...g, titleId: previous.get(g.name) ?? null }));
    state.history = { source, importedAt: new Date().toISOString(), entries: entries.length, groups };
    state.onboarded = true;
    host.save();
    host.afterHistoryImport?.();
    return state.history;
  }

  // Routes take (query: URLSearchParams, body) and return a body or [status, body].
  const routes = {
    'GET /api/state': () => publicState(),

    'GET /api/deck': (q) => {
      const n = Math.min(30, Number(q.get('n')) || 10);
      return { cards: nextDeck({ ...context(), excludeIds: ids(q), n }) };
    },

    'POST /api/swipe': (q, { id, action } = {}) => {
      const { state, catalog } = host;
      if (!catalog.byId.has(id) || !['like', 'super', 'nope'].includes(action)) return [400, { error: 'Unknown title or action' }];
      state.swipes = state.swipes.filter((s) => s.id !== id);
      state.swipes.push({ id, action, at: new Date().toISOString() });
      host.save();
      return { ok: true, stats: publicState().stats };
    },

    'POST /api/rewind': () => {
      const last = host.state.swipes.pop();
      if (!last) return [404, { error: 'Nothing to rewind' }];
      host.save();
      const t = host.catalog.byId.get(last.id);
      return { card: t && cardFor(context(), t), action: last.action };
    },

    'POST /api/unswipe': (q, { id } = {}) => {
      host.state.swipes = host.state.swipes.filter((s) => s.id !== id);
      host.save();
      return { ok: true };
    },

    'GET /api/lucky': (q) => {
      const card = feelingLucky({ ...context(), excludeIds: ids(q) });
      return card ? { card } : [404, { error: 'You have swiped through everything that matches your settings.' }];
    },

    'GET /api/likes': () => {
      const ctx = context();
      const likes = host.state.swipes
        .filter((s) => s.action !== 'nope' && host.catalog.byId.has(s.id))
        .reverse()
        .map((s) => ({ ...cardFor(ctx, host.catalog.byId.get(s.id)), action: s.action, at: s.at }));
      return { likes };
    },

    'POST /api/settings': (q, body = {}) => {
      const { state } = host;
      const next = { ...state.settings };
      if (typeof body.includeWatched === 'boolean') next.includeWatched = body.includeWatched;
      if (['both', 'movie', 'series'].includes(body.types)) next.types = body.types;
      if (Number.isFinite(body.minRating)) next.minRating = Math.max(0, Math.min(9.5, body.minRating));
      if (host.capabilities.tmdb) {
        if (typeof body.region === 'string' && /^[A-Z]{2}$/.test(body.region)) next.region = body.region;
        if (typeof body.tmdbKey === 'string') next.tmdbKey = body.tmdbKey.trim();
      }
      const catalogChanged = next.tmdbKey !== state.settings.tmdbKey || next.region !== state.settings.region;
      state.settings = next;
      host.save();
      host.afterSettings?.({ catalogChanged });
      return publicState();
    },

    'POST /api/history/csv': (q, text = '') => {
      const entries = parseViewingHistoryCsv(text);
      if (!entries.length) return [400, { error: "That file doesn't look like a Netflix viewing history CSV." }];
      const h = importHistory(entries, 'csv');
      return { ok: true, entries: h.entries, titles: h.groups.length };
    },

    // From the browser extension: [{title, date}] with the date as Netflix wrote it.
    'POST /api/history/entries': (q, { rows } = {}) => {
      const entries = Array.isArray(rows)
        ? entriesFromRows(rows.slice(0, 200000).filter((r) => r && typeof r.title === 'string').map((r) => ({ title: r.title, date: typeof r.date === 'string' ? r.date : '' })))
        : [];
      if (!entries.length) return [400, { error: 'No viewing activity was found.' }];
      const h = importHistory(entries, 'extension');
      return { ok: true, entries: h.entries, titles: h.groups.length };
    },

    'POST /api/onboarded': () => {
      host.state.onboarded = true;
      host.save();
      return { ok: true };
    },

    'POST /api/reset': (q, { scope = 'swipes' } = {}) => {
      if (scope === 'all') host.state = host.resetAll();
      else host.state.swipes = [];
      host.save();
      return publicState();
    },
  };

  return { routes, publicState, importHistory, context };
}
