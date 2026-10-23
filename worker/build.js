// Builds one country's Netflix catalog in the background (a Cloudflare Workflow).
// A build is ~40 listing pages plus ~1,000 detail lookups, so it runs as retryable steps
// instead of inside a single request.
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { createTmdb } from '../src/tmdb.js';
import { discoverRefs, fetchTitles, applyRatings, fetchTrending, MIN_NETFLIX_TITLES } from '../src/catalog.js';
import { imdbRatings } from '../src/imdb.js';

const RETRY = { retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' }, timeout: '10 minutes' };
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export class BuildCatalog extends WorkflowEntrypoint {
  async run(event, step) {
    const { region } = event.payload;
    const shared = this.env.SHARED.get(this.env.SHARED.idFromName('global'));
    const running = (message, progress) => shared.jobSet(region, { state: 'running', message, progress });
    try {
      if (!this.env.TMDB_API_KEY) throw new NonRetryableError('No TMDB key is configured');
      const tmdb = createTmdb(this.env.TMDB_API_KEY, undefined, this.env.TMDB_BASE || undefined);

      const refs = await step.do('discover', RETRY, async () => {
        await running(`Finding what's on Netflix ${region}…`, 0.02);
        return discoverRefs(tmdb, region);
      });
      if (refs.length < MIN_NETFLIX_TITLES) throw new NonRetryableError(`Netflix has no catalog we can read for ${region}`);

      const titles = [];
      const batches = chunks(refs, 60);
      for (let i = 0; i < batches.length; i++) {
        titles.push(...await step.do(`details-${i}`, RETRY, async () => {
          await running('Reading titles, cast and keywords…', 0.1 + 0.65 * (i / batches.length));
          return fetchTitles(tmdb, batches[i]);
        }));
      }

      const ratings = await step.do('ratings', RETRY, async () => {
        await running('Adding IMDb ratings…', 0.8);
        try {
          return Object.fromEntries(await imdbRatings(titles.map((t) => t.imdbId).filter(Boolean), { url: this.env.IMDB_URL || undefined }));
        } catch {
          return {}; // TMDB's own score is used instead
        }
      });

      await step.do('save', RETRY, async () => {
        applyRatings(titles, ratings);
        await this.env.CACHE.put(`catalog/${region}.json`, JSON.stringify({ region, builtAt: Date.now(), titles }));
        await this.env.CACHE.put(`trending/${region}.json`, JSON.stringify({ at: Date.now(), scores: await fetchTrending(tmdb, region).catch(() => ({})) }));
        await shared.jobSet(region, { state: 'done', message: `${titles.length} Netflix titles ready`, progress: 1 });
      });
    } catch (err) {
      await shared.jobSet(region, { state: 'error', message: err.message || 'The catalog build failed' });
      throw err;
    }
  }
}
