// The built-in sample: 100 Netflix originals with IMDb ratings, used until the full catalog is ready.
import raw from '../data/demo-catalog.json' with { type: 'json' };
import { netflixUrl } from './catalog.js';

export const loadDemoCatalog = () => raw.titles.map((t) => ({ ...t, netflixUrl: netflixUrl(t.title) }));
