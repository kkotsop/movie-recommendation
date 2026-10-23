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
export const rating = (id) => 6 + (id % 4); // 6..9, so the IMDb file visibly changes scores

export const detail = (kind, id, over = {}) => ({
  id, ...(kind === 'movie' ? { title: `Movie ${id - 100}`, original_title: `Movie ${id - 100}`, release_date: '2020-05-05', runtime: 100 }
    : { name: `Series ${id - 200}`, original_name: `Series ${id - 200}`, first_air_date: '2019-03-03', episode_run_time: [45], number_of_seasons: 2 }),
  genres: [{ name: GENRES[id % GENRES.length] }], overview: `About ${id}`, vote_average: 5, popularity: 10, original_language: 'en',
  poster_path: `/p${id}.jpg`, imdb_id: `tt${id}`, external_ids: { imdb_id: `tt${id}` },
  keywords: kind === 'movie' ? { keywords: [{ name: 'kw' }] } : { results: [{ name: 'kw' }] },
  credits: { cast: [{ name: 'Actor' }], crew: [] }, aggregate_credits: { cast: [{ name: 'Actor' }] }, created_by: [], ...over,
});

/** A fake TMDB and IMDb. Records every request path in `requests`. Countries named ZZ have no Netflix catalog. */
export async function fakeTmdbServer() {
  const requests = [];
  const gz = zlib.gzipSync(`tconst\taverageRating\tnumVotes\n${[...MOVIES, ...SERIES].map((id) => `tt${id}\t${rating(id)}\t50000`).join('\n')}\n`);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = u.pathname.replace(/^\/3/, '');
    const page1 = u.searchParams.get('page') === '1';
    const empty = u.searchParams.get('watch_region') === 'ZZ';
    let m;
    if (u.pathname === '/title.ratings.tsv.gz') { res.writeHead(200); return res.end(gz); }
    if (p === '/discover/movie') return send({ results: page1 && !empty ? MOVIES.map((id) => ({ id })) : [] });
    if (p === '/discover/tv') return send({ results: page1 && !empty ? SERIES.map((id) => ({ id })) : [] });
    if (p === '/trending/movie/day') return send({ results: page1 ? [{ id: 105 }, { id: 104 }, { id: 103 }] : [] });
    if (p === '/trending/tv/day') return send({ results: [] });
    if (p === '/search/movie') return send({ results: u.searchParams.get('query') === 'Old Movie' ? [{ id: 999, title: 'Old Movie' }] : [] });
    if (p === '/search/tv') return send({ results: u.searchParams.get('query') === 'Series 3' ? [{ id: 203, name: 'Series 3' }] : [] });
    if (p === '/search/multi') return send({ results: [] });
    if (p === '/movie/999') return send(detail('movie', 999, { title: 'Old Movie', original_title: 'Old Movie', genres: [{ name: 'Horror' }], release_date: '1999-01-01' }));
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
export async function buildFixtureCatalogs(fake, regions = ['US'], { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swipeflick-catalogs-')), previous, now } = {}) {
  const catalogs = await buildCatalogs({
    tmdb: createTmdb('k', undefined, fake.base), regions, previous, now,
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
