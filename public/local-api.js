// Static-hosting backend: the same engine as the Node server, running in the
// browser. State lives in this browser's localStorage and nothing is uploaded.
// (Used automatically when there is no /api server, e.g. on Cloudflare.)
// ./src/* and ./data/* are copied next to this file by scripts/build-static.mjs.
import { createEngine } from './src/engine.js';

const KEY = 'swipeflick.state.v1';
const DEFAULT_SETTINGS = { includeWatched: false, types: 'both', minRating: 0, region: 'US', tmdbKey: '' };

const fresh = () => ({ settings: { ...DEFAULT_SETTINGS }, onboarded: false, history: null, swipes: [] });

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) return { ...fresh(), ...s, settings: { ...DEFAULT_SETTINGS, ...s.settings } };
  } catch {}
  return fresh();
}

export async function createLocalApi() {
  const res = await fetch('./data/demo-catalog.json');
  if (!res.ok) throw new Error('Could not load the catalog');
  const titles = (await res.json()).titles.map((t) => ({ ...t, netflixUrl: `https://www.netflix.com/search?q=${encodeURIComponent(t.title)}` }));

  const host = {
    state: load(),
    catalog: { source: 'demo', titles, byId: new Map(titles.map((t) => [t.id, t])), builtAt: null },
    jobs: { netflix: { state: 'idle' }, catalog: { state: 'idle' } },
    capabilities: { netflixLogin: false, tmdb: false },
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(host.state)); } catch {} // private mode / quota: keep working in memory
    },
    resetAll() {
      try { localStorage.removeItem(KEY); } catch {}
      return fresh();
    },
  };
  const { routes } = createEngine(host);

  async function call(method, path, body) {
    const url = new URL(path, location.href);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw Object.assign(new Error('Not found'), { status: 404 });
    let out = route(url.searchParams, body);
    if (!Array.isArray(out)) return structuredClone(out);
    const [status, data] = out;
    if (status >= 400) throw Object.assign(new Error(data.error || `Request failed (${status})`), { status });
    return structuredClone(data);
  }

  return {
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
  };
}
