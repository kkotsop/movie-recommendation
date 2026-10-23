// IMDb ratings from IMDb's official non-commercial dataset
// (https://developer.imdb.com/non-commercial-datasets/), refreshed weekly.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CACHE_DIR } from './store.js';

const URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const FILE = path.join(CACHE_DIR, 'title.ratings.tsv.gz');
const MAX_AGE = 7 * 86400000;

async function ensureDataset() {
  try {
    if (Date.now() - fs.statSync(FILE).mtimeMs < MAX_AGE) return;
  } catch {}
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, (Number(process.env.IMDB_RETRY_MS) || 1500) * 2 ** attempt));
    try {
      const res = await fetch(URL);
      if (!res.ok) throw new Error(`IMDb dataset download failed (${res.status})`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${FILE}.tmp`));
      fs.renameSync(`${FILE}.tmp`, FILE);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  // An older copy is still far better than no ratings at all.
  if (fs.existsSync(FILE)) return;
  throw lastError;
}

/** Map imdbId -> {rating, votes} for the requested ids only. */
export async function imdbRatings(ids) {
  await ensureDataset();
  const want = new Set(ids);
  const out = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(FILE).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    const tab = line.indexOf('\t');
    const id = line.slice(0, tab);
    if (!want.has(id)) continue;
    const [, rating, votes] = line.split('\t');
    out.set(id, { rating: Number(rating), votes: Number(votes) });
    if (out.size === want.size) break;
  }
  return out;
}
