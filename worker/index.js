// SwipeFlick on Cloudflare Workers: a stateless JSON API in front of the static app (public/).
//
// Nothing about a person is stored. Each phone keeps its own Netflix history, swipes and settings
// and sends them along with every request; we compute recommendations and forget them.
// What IS stored is shared by everyone: the Netflix catalog per country (R2), TMDB lookups and
// build status (one Durable Object), and the owner's TMDB key (a Worker secret).
import { parseViewingHistoryCsv, groupHistory } from '../src/history.js';
import { resolveByTitle, resolveHistory, applyTrending, fetchTrending } from '../src/catalog.js';
import { loadDemoCatalog } from '../src/demo.js';
import { createTmdb } from '../src/tmdb.js';
import { buildProfile, nextDeck, feelingLucky, dailyPicks, topTastes, explain } from '../src/recommender.js';

export { Shared } from './shared.js';
export { BuildCatalog } from './build.js';

const WEEK = 7 * 86400000;
const CATALOG_TTL = 5 * 60 * 1000; // how long one Worker instance trusts its copy of a catalog
const MISS_TTL = 15 * 1000; // ...and of "there is no catalog yet"

// ---- shared state ------------------------------------------------------------

/** TMDB client with the owner's key. TMDB_BASE only exists so tests can point at a fake TMDB. */
const tmdbOf = (env) => createTmdb(env.TMDB_API_KEY, undefined, env.TMDB_BASE || undefined);
const sharedOf = (env) => env.SHARED.get(env.SHARED.idFromName('global'));
const defaultRegion = (env) => (/^[A-Za-z]{2}$/.test(env.DEFAULT_REGION || '') ? env.DEFAULT_REGION.toUpperCase() : 'US');
const regionOf = (v, env) => (/^[A-Z]{2}$/.test(v) ? v : defaultRegion(env));

const makeCatalog = (source, titles, builtAt = null) => ({ source, titles, byId: new Map(titles.map((t) => [t.id, t])), builtAt });
const netflixCount = (c) => c.titles.filter((t) => t.onNetflix !== false).length;

let demo;
const memo = new Map(); // region -> {at, catalog}; lives as long as this Worker instance
const lastBuildPoke = new Map();

/** The Netflix catalog for a country: from R2 once it's built, the built-in sample until then. */
async function getCatalog(env, ctx, region) {
  const hit = memo.get(region);
  if (hit && Date.now() - hit.at < (hit.catalog.source === 'tmdb' ? CATALOG_TTL : MISS_TTL)) return hit.catalog;

  const [file, trending] = await Promise.all([env.CACHE.get(`catalog/${region}.json`), env.CACHE.get(`trending/${region}.json`)]);
  if (file) {
    const data = await file.json();
    applyTrending(data.titles, trending ? (await trending.json()).scores : null);
    const catalog = makeCatalog('tmdb', data.titles, data.builtAt);
    memo.set(region, { at: Date.now(), catalog });
    return catalog;
  }

  demo ||= makeCatalog('demo', loadDemoCatalog());
  memo.set(region, { at: Date.now(), catalog: demo });
  if (env.TMDB_API_KEY && Date.now() - (lastBuildPoke.get(region) || 0) > 60000) {
    lastBuildPoke.set(region, Date.now());
    ctx.waitUntil(sharedOf(env).ensureBuild(region).catch(() => {}));
  }
  return demo;
}

// ---- reading what the phone sends ------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const titleId = (v) => (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? v : null);
const ACTIONS = new Set(['like', 'super', 'nope']);

/** Everything about a person arrives in the request body; none of it is trusted or kept. */
function parseState(body = {}, env) {
  const s = body.settings || {};
  return {
    region: regionOf(body.region, env),
    settings: {
      includeWatched: s.includeWatched === true,
      types: ['both', 'movie', 'series'].includes(s.types) ? s.types : 'both',
      minRating: Number.isFinite(s.minRating) ? clamp(s.minRating, 0, 9.5) : 0,
    },
    swipes: (Array.isArray(body.swipes) ? body.swipes : []).slice(0, 20000)
      .filter((x) => x && typeof x.id === 'string' && ACTIONS.has(x.action))
      .map((x) => ({ id: x.id.slice(0, 64), action: x.action, at: str(x.at, 40) || null })),
    groups: (Array.isArray(body.history?.groups) ? body.history.groups : []).slice(0, 3000)
      .filter((g) => g && typeof g.name === 'string' && g.name)
      .map((g) => ({
        name: str(g.name), kind: g.kind === 'series' ? 'series' : 'movie',
        views: clamp(Math.floor(Number(g.views)) || 1, 1, 100000),
        firstWatched: isoDate(g.firstWatched), lastWatched: isoDate(g.lastWatched), titleId: titleId(g.titleId),
      })),
    excludeIds: new Set((Array.isArray(body.exclude) ? body.exclude : []).slice(0, 500).map((x) => str(x, 64))),
  };
}

/** Two lookups in one: the country's catalog first, then titles someone watched that left Netflix. */
const layered = (a, b) => ({ get: (id) => a.get(id) ?? b.get(id), has: (id) => a.has(id) || b.has(id) });

async function contextFrom(env, ctx, body) {
  const st = parseState(body, env);
  const catalog = await getCatalog(env, ctx, st.region);

  // The phone remembers which TMDB title each watched show matched. Titles that are not in this country's
  // catalog (e.g. it left Netflix) come from the shared lookup table, in one call.
  const wanted = [...new Set(st.groups.map((g) => g.titleId).filter((id) => id && !catalog.byId.has(id)))];
  const extras = new Map((wanted.length ? await sharedOf(env).getTitles(wanted) : []).map((t) => [t.id, t]));
  const byId = layered(catalog.byId, extras);

  const byName = resolveByTitle(st.groups, catalog.titles); // fallback when the phone has no match yet
  const resolved = st.groups.map((g, i) => ({ ...g, titleId: g.titleId && byId.has(g.titleId) ? g.titleId : byName[i].titleId }));
  const watched = resolved.filter((g) => g.titleId);
  const swipes = st.swipes.filter((s) => byId.has(s.id));
  return {
    st, catalog, resolved, swipes,
    ctx: {
      catalog: catalog.titles,
      profile: buildProfile({ byId, watched, swipes }),
      swipedIds: new Set(swipes.map((s) => s.id)),
      watchedIds: new Set(watched.map((g) => g.titleId)),
      settings: st.settings,
    },
  };
}

const cardFor = (c, t) => ({ ...t, watched: c.watchedIds.has(t.id), reason: explain(c.profile, t) });

// ---- HTTP ---------------------------------------------------------------------

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status, error) => Object.assign(new Error(error), { status });

async function readText(request, limit = 3 * 1024 * 1024) {
  if (Number(request.headers.get('content-length')) > limit) throw fail(413, 'That is too large');
  const text = await request.text();
  if (text.length > limit) throw fail(413, 'That is too large');
  return text;
}
async function readJson(request, limit) {
  try { return JSON.parse((await readText(request, limit)) || '{}'); } catch (err) { throw err.status ? err : fail(400, 'Bad request'); }
}

const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'local';
const tooMany = (what = 'Slow down a little and try again in a few minutes.') => json({ error: what }, 429);

const routes = {
  'GET /api/catalog': async (request, url, env, ctx) => {
    const region = regionOf(url.searchParams.get('region'), env);
    const catalog = await getCatalog(env, ctx, region);
    const job = await sharedOf(env).jobGet(region);
    return json({ region, source: catalog.source, count: netflixCount(catalog), builtAt: catalog.builtAt, job: { state: job.state, message: job.message, progress: job.progress }, defaultRegion: defaultRegion(env) });
  },

  // Summary for the Profile tab and the badges.
  'POST /api/profile': async (request, url, env, ctx) => {
    const body = await readJson(request);
    const { st, catalog, resolved, ctx: c } = await contextFrom(env, ctx, body);
    const count = (a) => st.swipes.filter((s) => s.action === a).length;
    const h = body.history || {};
    const job = await sharedOf(env).jobGet(st.region);
    return json({
      catalog: { source: catalog.source, count: netflixCount(catalog), builtAt: catalog.builtAt },
      job: { state: job.state, message: job.message, progress: job.progress },
      history: st.groups.length ? {
        source: str(h.source, 20), importedAt: str(h.importedAt, 40), entries: clamp(Math.floor(Number(h.entries)) || 0, 0, 1e7),
        titles: st.groups.length, matched: resolved.filter((g) => g.titleId).length,
        recent: resolved.slice(0, 12).map((g) => ({ name: g.name, kind: g.kind, views: g.views, lastWatched: g.lastWatched, matched: Boolean(g.titleId) })),
      } : null,
      stats: { likes: count('like'), supers: count('super'), nopes: count('nope'), remaining: c.catalog.length - c.swipedIds.size },
      taste: topTastes(c.profile),
    });
  },

  'POST /api/deck': async (request, url, env, ctx) => {
    const body = await readJson(request);
    const { st, ctx: c } = await contextFrom(env, ctx, body);
    return json({ cards: nextDeck({ ...c, excludeIds: st.excludeIds, n: clamp(Math.floor(Number(body.n)) || 10, 1, 30) }) });
  },

  'POST /api/lucky': async (request, url, env, ctx) => {
    const { st, ctx: c } = await contextFrom(env, ctx, await readJson(request));
    const card = feelingLucky({ ...c, excludeIds: st.excludeIds });
    return card ? json({ card }) : json({ error: 'You have swiped through everything that matches your settings.' }, 404);
  },

  // Same list all day (seeded by the local date the phone sends), a new one tomorrow.
  'POST /api/daily': async (request, url, env, ctx) => {
    const body = await readJson(request);
    const { ctx: c } = await contextFrom(env, ctx, body);
    const date = isoDate(body.date) || new Date().toISOString().slice(0, 10);
    return json({ date, cards: dailyPicks({ ...c, excludeIds: new Set(), date }) });
  },

  'POST /api/likes': async (request, url, env, ctx) => {
    const { catalog, swipes, ctx: c } = await contextFrom(env, ctx, await readJson(request));
    const likes = swipes.filter((s) => s.action !== 'nope' && catalog.byId.has(s.id)).reverse()
      .map((s) => ({ ...cardFor(c, catalog.byId.get(s.id)), action: s.action, at: s.at }));
    return json({ likes });
  },

  // Full card data for a few ids (used by rewind).
  'POST /api/cards': async (request, url, env, ctx) => {
    const body = await readJson(request);
    const { catalog, ctx: c } = await contextFrom(env, ctx, body);
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 30).map((x) => str(x, 64));
    return json({ cards: ids.filter((id) => catalog.byId.has(id)).map((id) => cardFor(c, catalog.byId.get(id))) });
  },

  // Parses a Netflix "Viewing activity" CSV into show/movie groups. Nothing is kept.
  'POST /api/history/import': async (request, url, env) => {
    if (!await sharedOf(env).limit(`import:${clientIp(request)}`, 20, 600000)) return tooMany();
    const entries = parseViewingHistoryCsv(await readText(request, 5 * 1024 * 1024));
    if (!entries.length) return json({ error: "That file doesn't look like a Netflix viewing history CSV." }, 400);
    return json({ entries: entries.length, groups: groupHistory(entries).slice(0, 3000) });
  },

  // Looks a batch of watched titles up on TMDB and returns the match for each. The lookups are shared,
  // so a title only ever costs one TMDB call across everyone.
  'POST /api/history/resolve': async (request, url, env, ctx) => {
    const shared = sharedOf(env);
    if (!await shared.limit(`resolve:${clientIp(request)}`, 60, 600000)) return tooMany();
    const st = parseState(await readJson(request), env);
    const groups = st.groups.slice(0, 40);
    if (!env.TMDB_API_KEY) return json({ ids: groups.map(() => null) });
    const catalog = await getCatalog(env, ctx, st.region);
    const ids = await resolveHistory({ tmdb: tmdbOf(env), groups, knownIds: new Set(catalog.byId.keys()), shared });
    return json({ ids });
  },

  // On iPhone the home-screen app can't see data saved in Safari, so a code carries it across.
  'POST /api/transfer': async (request, url, env) => {
    const shared = sharedOf(env);
    if (!await shared.limit(`transfer:${clientIp(request)}`, 10, 600000)) return tooMany('Too many codes. Try again in a few minutes.');
    const body = await readJson(request, 2 * 1024 * 1024);
    if (typeof body.payload !== 'string' || !body.payload) return json({ error: 'Nothing to transfer' }, 400);
    const code = await shared.transferCreate(body.payload);
    return code ? json({ code, expiresInMinutes: 10 }) : json({ error: 'Busy. Try again in a few minutes.' }, 503);
  },

  'POST /api/transfer/claim': async (request, url, env) => {
    const shared = sharedOf(env);
    if (!await shared.limit(`claim:${clientIp(request)}`, 10, 600000)) return tooMany('Too many tries. Wait a few minutes.');
    const code = str((await readJson(request)).code, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const payload = code ? await shared.transferClaim(code) : null;
    return payload ? json({ payload }) : json({ error: 'That code is not valid, or it has expired.' }, 404);
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) return url.pathname.startsWith('/api/') ? json({ error: 'Not found' }, 404) : env.ASSETS.fetch(request);
    try {
      return await handler(request, url, env, ctx);
    } catch (err) {
      return json({ error: err.status ? err.message : 'Something went wrong' }, err.status || 500);
    }
  },

  // Every few hours: refresh trending once a day and rebuild any catalog older than a week.
  async scheduled(event, env, ctx) {
    if (!env.TMDB_API_KEY) return;
    const shared = sharedOf(env);
    const tmdb = tmdbOf(env);
    for (const region of await shared.regionsBuilt()) {
      const catalog = await env.CACHE.head(`catalog/${region}.json`);
      const trending = await env.CACHE.get(`trending/${region}.json`);
      const at = trending ? (await trending.json()).at : 0;
      if (Date.now() - at > 20 * 3600000) {
        const scores = await fetchTrending(tmdb, region).catch(() => null);
        if (scores) await env.CACHE.put(`trending/${region}.json`, JSON.stringify({ at: Date.now(), scores }));
      }
      if (!catalog || Date.now() - catalog.uploaded.getTime() > WEEK) ctx.waitUntil(shared.ensureBuild(region, true));
    }
  },
};
