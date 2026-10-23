// SwipeFlick server: serves the app and a stateless JSON API.
//
// Nothing about a person is stored here. Each phone keeps its own Netflix history, swipes and
// settings and sends them along with every request; we compute recommendations and forget them.
// The only things on disk are shared by everyone: the Netflix catalog, TMDB lookups and ratings.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readCache } from './src/store.js';
import { parseViewingHistoryCsv, groupHistory, normalizeTitle } from './src/history.js';
import { loadDemoCatalog, buildTmdbCatalog, cachedTmdbCatalog, resolveByTitle, resolveHistory, applyTrending, refreshTrending } from './src/catalog.js';
import { buildProfile, nextDeck, feelingLucky, dailyPicks, topTastes, explain } from './src/recommender.js';

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// The owner's TMDB key. Visitors never see it, enter it, or need a TMDB account.
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const DEFAULT_REGION = /^[A-Za-z]{2}$/.test(process.env.DEFAULT_REGION || '') ? process.env.DEFAULT_REGION.toUpperCase() : 'US';
// HOSTED=1: reachable by anyone with the link (any Host header, proxy-aware rate limiting).
const HOSTED = process.env.HOSTED === '1';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const WEEK = 7 * 86400000;

// ---- shared catalogs (one per Netflix country) -----------------------------

const catalogs = new Map(); // region -> {source, titles, byId, builtAt}
const jobs = new Map(); // region -> {state, message, progress}
let buildQueue = Promise.resolve(); // one TMDB build at a time, so we stay inside TMDB's rate limits
let demo;

const makeCatalog = (source, titles, builtAt = null) => ({ source, titles, byId: new Map(titles.map((t) => [t.id, t])), builtAt });
const netflixCount = (c) => c.titles.filter((t) => t.onNetflix !== false).length;

function getCatalog(region) {
  const have = catalogs.get(region);
  if (have) return have;
  const cached = TMDB_KEY && cachedTmdbCatalog(region);
  if (cached) {
    applyTrending(cached.titles, readCache(`trending-${region}.json`)?.scores); // even yesterday's trend beats none
    const c = makeCatalog('tmdb', cached.titles, cached.builtAt);
    catalogs.set(region, c);
    return c;
  }
  demo ||= makeCatalog('demo', loadDemoCatalog());
  if (TMDB_KEY) startBuild(region); // meanwhile everyone swipes the built-in sample
  return demo;
}

function startBuild(region, force = false) {
  if (!TMDB_KEY || jobs.get(region)?.state === 'running') return;
  jobs.set(region, { state: 'running', message: 'Waiting for its turn…', progress: 0 });
  buildQueue = buildQueue.then(async () => {
    try {
      await buildTmdbCatalog({
        key: TMDB_KEY, region, force,
        onProgress: (message, progress) => jobs.set(region, { state: 'running', message, progress }),
      });
      const cached = cachedTmdbCatalog(region);
      const scores = await refreshTrending({ key: TMDB_KEY, region, force });
      if (scores) applyTrending(cached.titles, scores);
      const c = makeCatalog('tmdb', cached.titles, cached.builtAt);
      if (netflixCount(c) < 20) throw new Error(`Netflix has no catalog we can read for ${region}`);
      catalogs.set(region, c);
      jobs.set(region, { state: 'done', message: `${netflixCount(c)} Netflix titles ready`, progress: 1 });
    } catch (err) {
      jobs.set(region, { state: 'error', message: err.message });
    }
  });
}

/** Titles someone watched that are no longer on Netflix still shape taste, so every country's catalog learns them. */
function addHistoryTitles(extra) {
  for (const c of catalogs.values()) {
    for (const t of extra) if (!c.byId.has(t.id)) { c.titles.push(t); c.byId.set(t.id, t); }
  }
}

let searchIndex = null;
const searchCache = () => (searchIndex ||= readCache('tmdb-search.json') || {});

/** Matches history groups to catalog titles: TMDB lookups other people already paid for, then plain title matching. */
function resolveGroups(groups, catalog) {
  const byTitle = resolveByTitle(groups, catalog.titles);
  const cache = searchCache();
  return groups.map((g, i) => {
    const hit = cache[`${g.kind === 'series' ? 'tv' : 'movie'}|${normalizeTitle(g.name)}`];
    const id = hit ? `tmdb-${hit.kind}-${hit.id}` : null;
    return { ...g, titleId: id && catalog.byId.has(id) ? id : byTitle[i].titleId };
  });
}

// Keep the catalog fresh without anyone pressing a button: trending daily, the whole catalog weekly.
setInterval(() => {
  for (const [region, c] of catalogs) {
    if (c.source !== 'tmdb') continue;
    refreshTrending({ key: TMDB_KEY, region }).then((scores) => scores && applyTrending(c.titles, scores)).catch(() => {});
    if (c.builtAt && Date.now() - c.builtAt > WEEK) startBuild(region, true);
  }
}, 6 * 3600000).unref();

// ---- reading what the phone sends ------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const ACTIONS = new Set(['like', 'super', 'nope']);

/** Everything about a person arrives in the request body; none of it is trusted or kept. */
function parseState(body = {}) {
  const region = /^[A-Z]{2}$/.test(body.region) ? body.region : DEFAULT_REGION;
  const s = body.settings || {};
  const settings = {
    includeWatched: s.includeWatched === true,
    types: ['both', 'movie', 'series'].includes(s.types) ? s.types : 'both',
    minRating: Number.isFinite(s.minRating) ? clamp(s.minRating, 0, 9.5) : 0,
  };
  const swipes = (Array.isArray(body.swipes) ? body.swipes : []).slice(0, 20000)
    .filter((x) => x && typeof x.id === 'string' && ACTIONS.has(x.action))
    .map((x) => ({ id: x.id.slice(0, 64), action: x.action, at: str(x.at, 40) || null }));
  const groups = (Array.isArray(body.history?.groups) ? body.history.groups : []).slice(0, 3000)
    .filter((g) => g && typeof g.name === 'string' && g.name)
    .map((g) => ({
      name: str(g.name), kind: g.kind === 'series' ? 'series' : 'movie',
      views: clamp(Math.floor(Number(g.views)) || 1, 1, 100000),
      firstWatched: isoDate(g.firstWatched), lastWatched: isoDate(g.lastWatched),
    }));
  return { region, settings, swipes, groups, excludeIds: new Set((Array.isArray(body.exclude) ? body.exclude : []).slice(0, 500).map((x) => str(x, 64))) };
}

function contextFrom(body) {
  const st = parseState(body);
  const catalog = getCatalog(st.region);
  const resolved = resolveGroups(st.groups, catalog);
  const watched = resolved.filter((g) => g.titleId);
  const swipes = st.swipes.filter((s) => catalog.byId.has(s.id));
  const ctx = {
    catalog: catalog.titles,
    profile: buildProfile({ byId: catalog.byId, watched, swipes }),
    swipedIds: new Set(swipes.map((s) => s.id)),
    watchedIds: new Set(watched.map((g) => g.titleId)),
    settings: st.settings,
  };
  return { st, catalog, resolved, swipes, ctx };
}

const cardFor = (ctx, t) => ({ ...t, watched: ctx.watchedIds.has(t.id), reason: explain(ctx.profile, t) });
const jobFor = (region) => jobs.get(region) || { state: 'idle' };

// ---- rate limiting (per client, in memory) -----------------------------------

const buckets = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start >= windowMs) { buckets.set(key, { start: now, count: 1 }); return true; }
  return ++b.count <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.start > 3600000) buckets.delete(k); }, 600000).unref();

// The last X-Forwarded-For entry is the one our own proxy added; earlier ones are client-supplied.
const clientIp = (req) => (HOSTED && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',').pop().trim() : req.socket.remoteAddress) || '?';

// ---- device-to-device transfer codes -------------------------------------------
// On iPhone the home-screen app can't see data saved in Safari. A code lets someone carry their data across.
// It is held in memory for 10 minutes, handed over once, then deleted.
const transfers = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

// ---- HTTP ---------------------------------------------------------------------

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('That is too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const readJson = async (req, limit) => {
  const text = await readBody(req, limit);
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('Bad request'), { status: 400 }); }
};

const routes = {
  'GET /api/catalog': (req, url) => {
    const region = /^[A-Z]{2}$/.test(url.searchParams.get('region')) ? url.searchParams.get('region') : DEFAULT_REGION;
    const c = getCatalog(region);
    return { region, source: c.source, count: netflixCount(c), builtAt: c.builtAt, job: jobFor(region), defaultRegion: DEFAULT_REGION };
  },

  // Summary for the Profile tab and the badges.
  'POST /api/profile': async (req) => {
    const body = await readJson(req);
    const { st, catalog, resolved, ctx } = contextFrom(body);
    const count = (a) => st.swipes.filter((s) => s.action === a).length;
    const h = body.history || {};
    return {
      catalog: { source: catalog.source, count: netflixCount(catalog), builtAt: catalog.builtAt },
      job: jobFor(st.region),
      history: st.groups.length ? {
        source: str(h.source, 20), importedAt: str(h.importedAt, 40), entries: clamp(Math.floor(Number(h.entries)) || 0, 0, 1e7),
        titles: st.groups.length, matched: resolved.filter((g) => g.titleId).length,
        recent: resolved.slice(0, 12).map((g) => ({ name: g.name, kind: g.kind, views: g.views, lastWatched: g.lastWatched, matched: Boolean(g.titleId) })),
      } : null,
      stats: { likes: count('like'), supers: count('super'), nopes: count('nope'), remaining: ctx.catalog.length - ctx.swipedIds.size },
      taste: topTastes(ctx.profile),
    };
  },

  'POST /api/deck': async (req) => {
    const body = await readJson(req);
    const { st, ctx } = contextFrom(body);
    return { cards: nextDeck({ ...ctx, excludeIds: st.excludeIds, n: clamp(Math.floor(Number(body.n)) || 10, 1, 30) }) };
  },

  'POST /api/lucky': async (req) => {
    const { st, ctx } = contextFrom(await readJson(req));
    const card = feelingLucky({ ...ctx, excludeIds: st.excludeIds });
    return card ? { card } : [404, { error: 'You have swiped through everything that matches your settings.' }];
  },

  // Same list all day (seeded by the local date the phone sends), a new one tomorrow.
  'POST /api/daily': async (req) => {
    const body = await readJson(req);
    const { ctx } = contextFrom(body);
    const date = isoDate(body.date) || new Date().toISOString().slice(0, 10);
    return { date, cards: dailyPicks({ ...ctx, excludeIds: new Set(), date }) };
  },

  'POST /api/likes': async (req) => {
    const { catalog, swipes, ctx } = contextFrom(await readJson(req));
    const likes = swipes.filter((s) => s.action !== 'nope').reverse()
      .map((s) => ({ ...cardFor(ctx, catalog.byId.get(s.id)), action: s.action, at: s.at }));
    return { likes };
  },

  // Full card data for a few ids (used by rewind).
  'POST /api/cards': async (req) => {
    const body = await readJson(req);
    const { catalog, ctx } = contextFrom(body);
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 30).map((x) => str(x, 64));
    return { cards: ids.filter((id) => catalog.byId.has(id)).map((id) => cardFor(ctx, catalog.byId.get(id))) };
  },

  // Parses a Netflix "Viewing activity" CSV into show/movie groups. Nothing is kept.
  'POST /api/history/import': async (req) => {
    if (!allow(`import:${clientIp(req)}`, 20, 600000)) return [429, { error: 'Slow down a little and try again in a few minutes.' }];
    const entries = parseViewingHistoryCsv(await readBody(req, 5 * 1024 * 1024));
    if (!entries.length) return [400, { error: "That file doesn't look like a Netflix viewing history CSV." }];
    return { entries: entries.length, groups: groupHistory(entries).slice(0, 3000) };
  },

  // Looks a batch of watched titles up on TMDB. The answers are shared, so a title only ever costs one lookup.
  'POST /api/history/resolve': async (req) => {
    if (!allow(`resolve:${clientIp(req)}`, 60, 600000)) return [429, { error: 'Slow down a little and try again in a few minutes.' }];
    const st = parseState(await readJson(req));
    if (!TMDB_KEY) return { resolved: 0, total: 0 };
    const fresh = st.groups.slice(0, 40);
    const catalog = getCatalog(st.region);
    const { ids, extra } = await resolveHistory({ key: TMDB_KEY, groups: fresh, knownIds: new Set(catalog.byId.keys()) });
    searchIndex = null;
    addHistoryTitles(extra);
    return { resolved: ids.filter(Boolean).length, total: fresh.length };
  },

  'POST /api/transfer': async (req) => {
    if (!allow(`transfer:${clientIp(req)}`, 10, 600000)) return [429, { error: 'Too many codes. Try again in a few minutes.' }];
    const body = await readJson(req, 2 * 1024 * 1024);
    if (typeof body.payload !== 'string' || !body.payload) return [400, { error: 'Nothing to transfer' }];
    for (const [k, v] of transfers) if (Date.now() > v.expires) transfers.delete(k);
    if (transfers.size >= 500) return [503, { error: 'Busy. Try again in a few minutes.' }];
    const code = newCode();
    transfers.set(code, { payload: body.payload, expires: Date.now() + 600000 });
    return { code, expiresInMinutes: 10 };
  },

  'POST /api/transfer/claim': async (req) => {
    if (!allow(`claim:${clientIp(req)}`, 10, 600000)) return [429, { error: 'Too many tries. Wait a few minutes.' }];
    const code = str((await readJson(req)).code, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const t = transfers.get(code);
    if (!t || Date.now() > t.expires) return [404, { error: 'That code is not valid, or it has expired.' }];
    transfers.delete(code);
    return { payload: t.payload };
  },
};

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const headers = { ...SECURITY, 'content-type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` };
    if (rel === 'sw.js' || rel === 'index.html') headers['cache-control'] = 'no-cache'; // pick up new versions right away
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // Locally, only answer to localhost names so other websites can't drive this API via DNS rebinding.
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const hostOk = ALLOWED_HOSTS.length ? ALLOWED_HOSTS.includes(host) : HOSTED || ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (!hostOk) return send(res, 403, { error: 'Forbidden host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return req.method === 'GET' ? serveStatic(url, res) : send(res, 404, { error: 'Not found' });
  if (!allow(`api:${clientIp(req)}`, 600, 60000)) return send(res, 429, { error: 'Too many requests. Try again in a minute.' });
  try {
    const out = await handler(req, url);
    if (Array.isArray(out)) send(res, out[0], out[1]);
    else send(res, 200, out);
  } catch (err) {
    send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🔥 SwipeFlick is running at http://localhost:${PORT}\n`);
  console.log(`  Catalog: ${TMDB_KEY ? `TMDB / Netflix (default ${DEFAULT_REGION})` : 'built-in demo (set TMDB_API_KEY for the full Netflix catalog)'}`);
  console.log("  Personal data: kept on each person's device, not on this server");
  if (TMDB_KEY) getCatalog(DEFAULT_REGION);
});
