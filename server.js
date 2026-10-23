// SwipeFlick local server: serves the UI and a small JSON API on 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, DEFAULT_SETTINGS } from './src/store.js';
import { parseViewingHistoryCsv, groupHistory } from './src/history.js';
import { loadDemoCatalog, buildTmdbCatalog, cachedTmdbCatalog, resolveByTitle, applyTrending, refreshTrending } from './src/catalog.js';
import { readCache } from './src/store.js';
import { buildProfile, nextDeck, feelingLucky, dailyPicks, topTastes, explain } from './src/recommender.js';
import { syncFromNetflix, forgetNetflixLogin } from './src/netflix.js';

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
// Hosted mode: set ACCESS_TOKEN and the API (your history, swipes, TMDB key) needs a login cookie.
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const HOSTED = Boolean(ACCESS_TOKEN);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const COOKIE = 'sf_auth';
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const COOKIE_VALUE = HOSTED ? sha(`${ACCESS_TOKEN}:cookie`) : '';
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

let state = loadState();
let catalog;
const jobs = { netflix: { state: 'idle' }, catalog: { state: 'idle' } };

function setCatalog(source, titles, builtAt = null) {
  catalog = { source, titles, byId: new Map(titles.map((t) => [t.id, t])), builtAt };
}

function loadCatalog() {
  const c = state.settings.tmdbKey && cachedTmdbCatalog(state.settings.region);
  if (c) {
    // Even yesterday's trending list is a better hint than none.
    applyTrending(c.titles, readCache(`trending-${state.settings.region}.json`)?.scores);
    setCatalog('tmdb', c.titles, c.builtAt);
  } else setCatalog('demo', loadDemoCatalog());
}

/** Fetches today's trending scores (cached for a day) and applies them to the live catalog. */
async function refreshTrendingNow(force = false) {
  const { tmdbKey, region } = state.settings;
  if (!tmdbKey || catalog.source !== 'tmdb') return;
  const scores = await refreshTrending({ key: tmdbKey, region, force });
  if (scores) applyTrending(catalog.titles, scores);
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
    await refreshTrendingNow(true);
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

function cookieOf(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
const isAuthed = (req) => !HOSTED || same(cookieOf(req, COOKIE), COOKIE_VALUE);
const isHttps = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const authCookie = (req) => `${COOKIE}=${COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isHttps(req) ? '; Secure' : ''}`;

// 10 wrong codes per 10 minutes per client, so the access code can't be guessed.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  return f && f.count >= 10 && Date.now() - f.first < 600000;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first >= 600000) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}
// The last X-Forwarded-For entry is the one our proxy added; earlier ones are client-supplied and can be forged.
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();

function publicState() {
  const ctx = context();
  const watched = resolvedHistory();
  const count = (a) => state.swipes.filter((s) => s.action === a).length;
  const { tmdbKey, ...settings } = state.settings;
  return {
    settings: { ...settings, hasTmdbKey: Boolean(tmdbKey) },
    features: { browserLogin: !HOSTED }, // the Playwright login needs a desktop; hosted/phone mode uses the bookmarklet
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

// Routes that work before you've unlocked the app.
const OPEN_ROUTES = new Set(['GET /api/auth', 'POST /api/login']);

const routes = {
  'GET /api/auth': (req) => ({ required: HOSTED, authed: isAuthed(req) }),

  'POST /api/login': async (req, url, res) => {
    if (!HOSTED) return { ok: true };
    const ip = clientIp(req);
    if (tooManyFailures(ip)) return [429, { error: 'Too many wrong codes. Try again in a few minutes.' }];
    const { code = '' } = await readJson(req);
    if (!same(sha(String(code)), sha(ACCESS_TOKEN))) {
      noteFailure(ip);
      return [401, { error: 'That code is not right.' }];
    }
    failures.delete(ip);
    res.setHeader('set-cookie', authCookie(req));
    return { ok: true };
  },

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

  // Same list all day (seeded by the local date), a new one tomorrow.
  'GET /api/daily': (req, url) => {
    const d = new Date();
    const today = url.searchParams.get('date') || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { date: today, cards: dailyPicks({ ...context(), excludeIds: new Set(), date: today }) };
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
    if (HOSTED) return [400, { error: 'Use the "Sync from Netflix" bookmark on your phone instead.' }];
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
    const headers = { 'content-type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` };
    if (rel === 'sw.js' || rel === 'index.html') headers['cache-control'] = 'no-cache'; // pick up new versions right away
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // Locally: only answer to localhost names, so other websites can't drive this API via DNS rebinding.
  // Hosted: the access code protects the API, and ALLOWED_HOSTS can pin the domain.
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const hostOk = ALLOWED_HOSTS.length ? ALLOWED_HOSTS.includes(host) : HOSTED || ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (!hostOk) return send(res, 403, { error: 'Forbidden host' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Private link: /?t=<access code> sets the login cookie and drops the code from the address bar.
  if (HOSTED && req.method === 'GET' && url.searchParams.has('t')) {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) return send(res, 429, { error: 'Too many wrong codes. Try again in a few minutes.' });
    const ok = same(sha(url.searchParams.get('t')), sha(ACCESS_TOKEN));
    if (ok) failures.delete(ip); else noteFailure(ip);
    url.searchParams.delete('t');
    res.writeHead(302, { location: url.pathname + url.search, ...(ok ? { 'set-cookie': authCookie(req) } : {}) });
    return res.end();
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return req.method === 'GET' ? serveStatic(url, res) : send(res, 404, { error: 'Not found' });
  if (!OPEN_ROUTES.has(key) && !isAuthed(req)) return send(res, 401, { error: 'locked' });
  try {
    const out = await handler(req, url, res);
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
  else refreshTrendingNow();
});
setInterval(() => refreshTrendingNow().catch(() => {}), 6 * 3600000).unref();
