// Shared test fixtures: a fake TMDB + IMDb, and a way to build real catalog files from them.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTmdb } from '../src/tmdb.js';
import { imdbRatings } from '../src/imdb.js';
import { buildCatalogs, writeCatalogs } from '../scripts/build-catalogs.js';

const GENRES = ['Drama', 'Comedy', 'Thriller', 'Sci-Fi'];
export const MOVIES = Array.from({ length: 30 }, (_, i) => 101 + i);
export const SERIES = Array.from({ length: 10 }, (_, i) => 201 + i);
export const STANDUP = [301, 302, 303, 304, 305, 306]; // stand-up specials: never in the popular lists, only found by asking for them
export const CONCERT = [311, 312, 313, 314];
export const WORLD = Array.from({ length: 10 }, (_, i) => 401 + i); // popular, but not on Netflix in any test country
export const KEYWORD_IDS = { 'stand-up comedy': 9716, concert: 1997 };
export const rating = (id) => 6 + (id % 4); // 6..9, so the IMDb file visibly changes scores

const movieName = (id) => (STANDUP.includes(id) ? `Stand-up ${id - 300}` : CONCERT.includes(id) ? `Concert ${id - 310}` : WORLD.includes(id) ? `Worldwide ${id - 400}` : `Movie ${id - 100}`);
const keywordsFor = (id) => (STANDUP.includes(id) ? ['stand-up comedy'] : CONCERT.includes(id) ? ['concert'] : ['kw']);

export const detail = (kind, id, over = {}) => ({
  id,
  ...(kind === 'movie'
    ? { title: movieName(id), original_title: movieName(id), release_date: '2020-05-05', runtime: 100 }
    : { name: `Series ${id - 200}`, original_name: `Series ${id - 200}`, first_air_date: '2019-03-03', episode_run_time: [45], number_of_seasons: 2 }),
  genres: [{ name: STANDUP.includes(id) ? 'Comedy' : CONCERT.includes(id) ? 'Music' : GENRES[id % GENRES.length] }], overview: `About ${id}`, vote_average: 5, popularity: 10, original_language: 'en',
  poster_path: `/p${id}.jpg`, imdb_id: `tt${id}`, external_ids: { imdb_id: `tt${id}` },
  keywords: kind === 'movie' ? { keywords: keywordsFor(id).map((name) => ({ name })) } : { results: keywordsFor(id).map((name) => ({ name })) },
  credits: { cast: [{ name: 'Actor' }], crew: [] }, aggregate_credits: { cast: [{ name: 'Actor' }] }, created_by: [], ...over,
});

/**
 * A fake TMDB and IMDb. Records every request path in `requests`. Countries named ZZ have no Netflix catalog.
 * Lists asked for by keyword return the stand-up and concert titles; lists without a country return worldwide titles.
 */
export async function fakeTmdbServer() {
  const requests = [];
  const everyId = [...MOVIES, ...SERIES, ...STANDUP, ...CONCERT, ...WORLD];
  const gz = zlib.gzipSync(`tconst\taverageRating\tnumVotes\n${everyId.map((id) => `tt${id}\t${rating(id)}\t50000`).join('\n')}\n`);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = u.pathname.replace(/^\/3/, '');
    const page1 = u.searchParams.get('page') === '1';
    const empty = u.searchParams.get('watch_region') === 'ZZ';
    let m;
    if (u.pathname === '/title.ratings.tsv.gz') { res.writeHead(200); return res.end(gz); }
    if (p === '/search/keyword') {
      const q = u.searchParams.get('query');
      return send({ results: KEYWORD_IDS[q] ? [{ id: KEYWORD_IDS[q], name: q }] : [] });
    }
    if (p === '/discover/movie' || p === '/discover/tv') {
      const movie = p.endsWith('movie');
      const kw = u.searchParams.get('with_keywords') || '';
      const worldwide = !u.searchParams.get('watch_region');
      let ids = [];
      if (kw.includes(String(KEYWORD_IDS['stand-up comedy']))) ids.push(...(movie ? STANDUP : []));
      if (kw.includes(String(KEYWORD_IDS.concert))) ids.push(...(movie ? CONCERT : []));
      if (!kw && !u.searchParams.get('with_genres')) ids = movie ? (worldwide ? [...MOVIES.slice(0, 12), ...WORLD] : MOVIES) : (worldwide ? SERIES.slice(0, 4) : SERIES);
      return send({ results: page1 && !empty ? ids.map((id) => ({ id })) : [] });
    }
    if (p === '/trending/movie/day') return send({ results: page1 ? [{ id: 105 }, { id: 104 }, { id: 103 }] : [] });
    if (p === '/trending/tv/day') return send({ results: [] });
    if ((m = p.match(/^\/(movie|tv)\/(\d+)$/))) return send(detail(m[1], Number(m[2])));
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    requests, port, base: `http://127.0.0.1:${port}/3`, imdbUrl: `http://127.0.0.1:${port}/title.ratings.tsv.gz`,
    close: () => server.close(),
  };
}

/** Builds real catalog files with the real builder against the fake TMDB. Returns the output folder. */
export async function buildFixtureCatalogs(fake, regions = ['US'], { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swipeflix-catalogs-')), previous, now, anywhere = true } = {}) {
  const catalogs = await buildCatalogs({
    tmdb: createTmdb('k', undefined, fake.base), regions, previous, now, anywhere,
    ratings: (ids) => imdbRatings(ids, { url: fake.imdbUrl, retryMs: 1 }),
  });
  writeCatalogs(dir, catalogs, now);
  return { dir, catalogs };
}

/** Serves a folder of static files, like raw.githubusercontent.com does for the data branch. */
export async function staticServer(root) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { hits, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
