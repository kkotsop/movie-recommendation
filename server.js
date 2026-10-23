// SwipeFlick local server: serves the UI and a small JSON API on 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, DEFAULT_SETTINGS } from './src/store.js';
import { loadDemoCatalog, buildTmdbCatalog, cachedTmdbCatalog } from './src/catalog.js';
import { createEngine } from './src/engine.js';
import { syncFromNetflix, forgetNetflixLogin } from './src/netflix.js';

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

let state = loadState();
let catalog;
const jobs = { netflix: { state: 'idle' }, catalog: { state: 'idle' } };

const host = {
  get state() { return state; },
  set state(v) { state = v; },
  get catalog() { return catalog; },
  jobs,
  capabilities: { netflixLogin: true, tmdb: true },
  save: () => saveState(state),
  afterHistoryImport: () => { if (state.settings.tmdbKey) rebuildCatalog(); },
  afterSettings: ({ catalogChanged }) => { if (catalogChanged) rebuildCatalog(); },
  resetAll() {
    forgetNetflixLogin();
    return { settings: { ...DEFAULT_SETTINGS, region: state.settings.region, tmdbKey: state.settings.tmdbKey }, swipes: [], history: null, onboarded: false };
  },
};
const engine = createEngine(host);

function setCatalog(source, titles, builtAt = null) {
  catalog = { source, titles, byId: new Map(titles.map((t) => [t.id, t])), builtAt };
}

function loadCatalog() {
  const c = state.settings.tmdbKey && cachedTmdbCatalog(state.settings.region);
  if (c) setCatalog('tmdb', c.titles, c.builtAt);
  else setCatalog('demo', loadDemoCatalog());
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

async function runNetflixSync() {
  if (['launching', 'waiting-login', 'reading'].includes(jobs.netflix.state)) return;
  const onStatus = (s, message) => { jobs.netflix = { state: s, message }; };
  try {
    const entries = await syncFromNetflix(onStatus);
    const h = engine.importHistory(entries, 'netflix');
    jobs.netflix = { state: 'done', message: `Imported ${h.entries} views across ${h.groups.length} titles.` };
  } catch (err) {
    jobs.netflix = { state: 'error', message: err.message };
  }
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

// Everything the in-browser build also supports lives in the shared engine;
// these are the Node-only extras.
const extra = {
  'POST /api/netflix/connect': () => {
    runNetflixSync();
    return { ok: true };
  },
  'POST /api/catalog/refresh': () => {
    rebuildCatalog({ force: true });
    return { ok: true };
  },
};

async function dispatch(req, url) {
  const key = `${req.method} ${url.pathname}`;
  if (extra[key]) return extra[key]();
  const route = engine.routes[key];
  if (!route) return undefined;
  const raw = req.method === 'POST' ? await readBody(req) : '';
  return route(url.searchParams, key === 'POST /api/history/csv' ? raw : JSON.parse(raw || '{}'));
}

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
  try {
    const out = await dispatch(req, url);
    if (out === undefined) return req.method === 'GET' ? serveStatic(url, res) : send(res, 404, { error: 'Not found' });
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
