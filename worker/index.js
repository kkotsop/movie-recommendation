// Swipeflix on Cloudflare Workers (free plan).
//
// The phone does the recommending: it downloads a country's catalog and scores it against the person's
// own history and swipes, so none of that ever reaches a server. This Worker only does the few things a
// phone cannot do for itself:
//   - hand out the country catalogs that a scheduled GitHub job builds (a cached pass-through)
//   - look up the names of watched titles the catalog does not know, using the owner's TMDB key
//   - hold one-time codes for moving data between devices
// The app itself (public/) is served as free static assets; only /api/* runs this code.
import { resolveHistory } from '../src/catalog.js';
import { createTmdb } from '../src/tmdb.js';
import { compactTitle } from '../public/lib/match.js';

export { Shared } from './shared.js';

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (status, error) => Object.assign(new Error(error), { status });
const sharedOf = (env) => env.SHARED.get(env.SHARED.idFromName('global'));
const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'local';
const tooMany = (what = 'Slow down a little and try again in a few minutes.') => json({ error: what }, 429);
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

/** Each lookup can cost ~3 TMDB calls and the free plan allows 50 outbound requests per call, so batches stay small. */
const RESOLVE_BATCH = 8;

async function readText(request, limit = 3 * 1024 * 1024) {
  if (Number(request.headers.get('content-length')) > limit) throw fail(413, 'That is too large');
  const text = await request.text();
  if (text.length > limit) throw fail(413, 'That is too large');
  return text;
}
async function readJson(request, limit) {
  try { return JSON.parse((await readText(request, limit)) || '{}'); } catch (err) { throw err.status ? err : fail(400, 'Bad request'); }
}

/** A country's catalog, built ahead of time by the scheduled GitHub job and published as a static file. */
async function catalogFile(request, region, env) {
  if (!/^[A-Z]{2}$/.test(region)) return json({ error: 'Unknown country' }, 404);
  const upstream = await fetch(`${env.CATALOG_BASE}/${region}.json.gz`, { cf: { cacheTtl: 6 * 3600, cacheEverything: true } }).catch(() => null);
  if (!upstream?.ok) return json({ error: `No catalog for ${region} yet` }, 404);
  // The file is already gzipped: pass the bytes straight through so the Worker does no work on them.
  // encodeBody 'manual' tells the runtime the body is already encoded; without it the bytes would be gzipped a second time.
  return new Response(upstream.body, {
    encodeBody: 'manual',
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', 'cache-control': 'public, max-age=3600' },
  });
}

const routes = {
  // Looks a few watched titles up by name on TMDB. The answers are shared, so a title only ever costs one lookup.
  // Only names and kinds arrive here: no dates, no swipes, nothing that says who is asking.
  'POST /api/history/resolve': async (request, env) => {
    const shared = sharedOf(env);
    if (!await shared.limit(`resolve:${clientIp(request)}`, 120, 600000)) return tooMany();
    const body = await readJson(request);
    const groups = (Array.isArray(body.groups) ? body.groups : []).slice(0, RESOLVE_BATCH)
      .filter((g) => g && typeof g.name === 'string' && g.name)
      .map((g) => ({ name: str(g.name), kind: g.kind === 'series' ? 'series' : 'movie' }));
    if (!env.TMDB_API_KEY || !groups.length) return json({ ids: groups.map(() => null), titles: {} });
    const tmdb = createTmdb(env.TMDB_API_KEY, undefined, env.TMDB_BASE || undefined);
    const ids = await resolveHistory({ tmdb, groups, knownIds: new Set(), shared });
    const found = await shared.getTitles(ids.filter(Boolean));
    return json({ ids, titles: Object.fromEntries(found.map((t) => [t.id, compactTitle(t)])) });
  },

  // On iPhone the home-screen app can't see data saved in Safari, so a code carries it across.
  'POST /api/transfer': async (request, env) => {
    const shared = sharedOf(env);
    if (!await shared.limit(`transfer:${clientIp(request)}`, 10, 600000)) return tooMany('Too many codes. Try again in a few minutes.');
    const body = await readJson(request, 2 * 1024 * 1024);
    if (typeof body.payload !== 'string' || !body.payload) return json({ error: 'Nothing to transfer' }, 400);
    const code = await shared.transferCreate(body.payload);
    return code ? json({ code, expiresInMinutes: 10 }) : json({ error: 'Busy. Try again in a few minutes.' }, 503);
  },

  'POST /api/transfer/claim': async (request, env) => {
    const shared = sharedOf(env);
    if (!await shared.limit(`claim:${clientIp(request)}`, 10, 600000)) return tooMany('Too many tries. Wait a few minutes.');
    const code = str((await readJson(request)).code, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const payload = code ? await shared.transferClaim(code) : null;
    return payload ? json({ payload }) : json({ error: 'That code is not valid, or it has expired.' }, 404);
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const catalog = request.method === 'GET' && url.pathname.match(/^\/api\/catalog\/([A-Za-z]{2})$/);
      if (catalog) return await catalogFile(request, catalog[1].toUpperCase(), env);
      const handler = routes[`${request.method} ${url.pathname}`];
      if (handler) return await handler(request, env);
      return url.pathname.startsWith('/api/') ? json({ error: 'Not found' }, 404) : env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err.status ? err.message : 'Something went wrong' }, err.status || 500);
    }
  },
};
