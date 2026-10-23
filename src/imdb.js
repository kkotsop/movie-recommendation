// IMDb ratings from IMDb's official non-commercial dataset
// (https://developer.imdb.com/non-commercial-datasets/). Streamed and scanned, never stored whole.
const DATASET = 'https://datasets.imdbws.com/title.ratings.tsv.gz';

/** Map imdbId -> {rating, votes} for the requested ids only. Retries a few times; throws if every try fails. */
export async function imdbRatings(ids, { fetchImpl = fetch, url = DATASET, retries = 3, retryMs = 1500 } = {}) {
  const want = new Set(ids);
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, retryMs * 2 ** attempt));
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`IMDb dataset download failed (${res.status})`);
      const out = new Map();
      const take = (line) => {
        const tab = line.indexOf('\t');
        if (tab < 0 || !want.has(line.slice(0, tab))) return;
        const [id, rating, votes] = line.split('\t');
        out.set(id, { rating: Number(rating), votes: Number(votes) });
      };
      const reader = res.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        let start = 0;
        for (let nl = buf.indexOf('\n', start); nl >= 0; nl = buf.indexOf('\n', start)) {
          take(buf.slice(start, nl));
          start = nl + 1;
        }
        buf = buf.slice(start);
        if (out.size === want.size) { await reader.cancel(); return out; }
      }
      take(buf);
      return out;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
