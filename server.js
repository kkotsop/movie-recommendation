// SwipeFlick local server: serves the UI and a small JSON API on 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, DEFAULT_SETTINGS } from './src/store.js';
import { parseViewingHistoryCsv, groupHistory } from './src/history.js';
import { loadDemoCatalog, buildTmdbCatalog, cachedTmdbCatalog, resolveByTitle } from './src/catalog.js';
import { buildProfile, nextDeck, feelingLucky, topTastes, explain } from './src/recommender.js';
import { syncFromNetflix, forgetNetflixLogin } from './src/netflix.js';

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

let state = loadState();
let catalog;
const jobs = { netflix: { state: 'idle' }, catalog: { state: 'idle' } };

function setCatalog(source, titles, builtAt = null) {
  catalog = { source, titles, byId: new Map(titles.map((t) => [t.id, t])), builtAt };
}

function loadCatalog() {
  const c = state.settings.tmdbKey && cachedTmdbCatalog(state.settings.region);
  if (c) setCatalog('tmdb', c.titles, c.builtAt);
  else setCatalog('demo', loadDemoCatalog());
}

/** History groups with titleId pointing into the current catalog. */
function resolvedHistory() {
  const groups = state.history?.groups || [];
  const byTitle = resolveByTitle(groups, catalog.titles);
  return groups.map((g, i) => {
    const stored = catalog.source === 'tmdb' && g.titleId && catalog.byId.has(g.titleId) ? g.titleId : null;
    return { ...g, titleId: stored || byTitle[i].titleId };
  });
}

function context() {
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

function cardFor(ctx, t) {
  return { ...t, watched: ctx.watchedIds.has(t.id), reason: explain(ctx.profile, t) };
}

async function rebuildCatalog({ force = false } = {}) {
  if (!state.settings.tmdbKey) { loadCatalog(); return; }
  if (jobs.catalog.state === 'running') return;
  jobs.catalog = { state: 'running', message: 'Starting…', progress: 0 };
  try {
    const { titles, groups } = await buildTmdbCatalog({
      key: state.settings.tmdbKey,
      region: state.settings.region,
      groups: state.history?.groups || [],
      force,
      onProgress: (message, progress) => { jobs.catalog = { state: 'running', message, progress }; },
    });
    if (state.history) state.history.groups = groups;
    saveState(state);
    loadCatalog();
    jobs.catalog = { state: 'done', message: `${titles.filter((t) => t.onNetflix).length} Netflix titles ready`, progress: 1 };
  } catch (err) {
    jobs.catalog = { state: 'error', message: err.message };
    loadCatalog();
  }
}

function importHistory(entries, source) {
  const previous = new Map((state.history?.groups || []).map((g) => [g.name, g.titleId]));
  const groups = groupHistory(entries).map((g) => ({ ...g, titleId: previous.get(g.name) ?? null }));
  state.history = { source, importedAt: new Date().toISOString(), entries: entries.length, groups };
  state.onboarded = true;
  saveState(state);
  if (state.settings.tmdbKey) rebuildCatalog();
  return state.history;
}

async function runNetflixSync() {
  if (['launching', 'waiting-login', 'reading'].includes(jobs.netflix.state)) return;
  const onStatus = (s, message) => { jobs.netflix = { state: s, message }; };
  try {
    const entries = await syncFromNetflix(onStatus);
    const h = importHistory(entries, 'netflix');
    jobs.netflix = { state: 'done', message: `Imported ${h.entries} views across ${h.groups.length} titles.` };
  } catch (err) {
    jobs.netflix = { state: 'error', message: err.message };
  }
}

function publicState() {
  const ctx = context();
  const watched = resolvedHistory();
  const count = (a) => state.swipes.filter((s) => s.action === a).length;
  const { tmdbKey, ...settings } = state.settings;
  return {
    settings: { ...settings, hasTmdbKey: Boolean(tmdbKey) },
    onboarded: state.onboarded,
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
    jobs,
  };
}

// ---- HTTP -------------------------------------------------------------------

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Upload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const readJson = async (req) => JSON.parse((await readBody(req)) || '{}');

const routes = {
  'GET /api/state': () => publicState(),

  'GET /api/deck': (req, url) => {
    const ctx = context();
    const excludeIds = new Set((url.searchParams.get('exclude') || '').split(',').filter(Boolean));
    const n = Math.min(30, Number(url.searchParams.get('n')) || 10);
    return { cards: nextDeck({ ...ctx, excludeIds, n }) };
  },

  'POST /api/swipe': async (req) => {
    const { id, action } = await readJson(req);
    if (!catalog.byId.has(id) || !['like', 'super', 'nope'].includes(action)) return [400, { error: 'Unknown title or action' }];
    state.swipes = state.swipes.filter((s) => s.id !== id);
    state.swipes.push({ id, action, at: new Date().toISOString() });
    saveState(state);
    return { ok: true, stats: publicState().stats };
  },

  'POST /api/rewind': () => {
    const last = state.swipes.pop();
    if (!last) return [404, { error: 'Nothing to rewind' }];
    saveState(state);
    const ctx = context();
    const t = catalog.byId.get(last.id);
    return { card: t && cardFor(ctx, t), action: last.action };
  },

  'POST /api/unswipe': async (req) => {
    const { id } = await readJson(req);
    state.swipes = state.swipes.filter((s) => s.id !== id);
    saveState(state);
    return { ok: true };
  },

  'GET /api/lucky': (req, url) => {
    const excludeIds = new Set((url.searchParams.get('exclude') || '').split(',').filter(Boolean));
    const card = feelingLucky({ ...context(), excludeIds });
    return card ? { card } : [404, { error: 'You have swiped through everything that matches your settings.' }];
  },

  'GET /api/likes': () => {
    const ctx = context();
    const likes = state.swipes
      .filter((s) => s.action !== 'nope' && catalog.byId.has(s.id))
      .reverse()
      .map((s) => ({ ...cardFor(ctx, catalog.byId.get(s.id)), action: s.action, at: s.at }));
    return { likes };
  },

  'POST /api/settings': async (req) => {
    const body = await readJson(req);
    const next = { ...state.settings };
    if (typeof body.includeWatched === 'boolean') next.includeWatched = body.includeWatched;
    if (['both', 'movie', 'series'].includes(body.types)) next.types = body.types;
    if (Number.isFinite(body.minRating)) next.minRating = Math.max(0, Math.min(9.5, body.minRating));
    if (typeof body.region === 'string' && /^[A-Z]{2}$/.test(body.region)) next.region = body.region;
    if (typeof body.tmdbKey === 'string') next.tmdbKey = body.tmdbKey.trim();
    const catalogChanged = next.tmdbKey !== state.settings.tmdbKey || next.region !== state.settings.region;
    state.settings = next;
    saveState(state);
    if (catalogChanged) rebuildCatalog();
    return publicState();
  },

  'POST /api/history/csv': async (req) => {
    const entries = parseViewingHistoryCsv(await readBody(req));
    if (!entries.length) return [400, { error: "That file doesn't look like a Netflix viewing history CSV." }];
    const h = importHistory(entries, 'csv');
    return { ok: true, entries: h.entries, titles: h.groups.length };
  },

  'POST /api/netflix/connect': () => {
    runNetflixSync();
    return { ok: true };
  },

  'POST /api/catalog/refresh': () => {
    rebuildCatalog({ force: true });
    return { ok: true };
  },

  'POST /api/onboarded': () => {
    state.onboarded = true;
    saveState(state);
    return { ok: true };
  },

  'POST /api/reset': async (req) => {
    const { scope = 'swipes' } = await readJson(req);
    if (scope === 'all') {
      state = { settings: { ...DEFAULT_SETTINGS, region: state.settings.region, tmdbKey: state.settings.tmdbKey }, swipes: [], history: null, onboarded: false };
      forgetNetflixLogin();
    } else {
      state.swipes = [];
    }
    saveState(state);
    return publicState();
  },
};

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // Only answer to localhost names, so other websites can't drive this API via DNS rebinding.
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { error: 'Forbidden host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return req.method === 'GET' ? serveStatic(url, res) : send(res, 404, { error: 'Not found' });
  try {
    const out = await handler(req, url);
    if (Array.isArray(out)) send(res, out[0], out[1]);
    else send(res, 200, out);
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

loadCatalog();
server.listen(PORT, HOST, () => {
  console.log(`\n  🔥 SwipeFlick is running at http://localhost:${PORT}\n`);
  console.log(`  Catalog: ${catalog.source === 'tmdb' ? `TMDB / Netflix ${state.settings.region}` : 'built-in demo (add a TMDB key in Profile for the full Netflix catalog)'}`);
  if (state.settings.tmdbKey && catalog.source === 'demo') rebuildCatalog();
});
