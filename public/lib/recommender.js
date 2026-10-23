// Content-based recommender with Tinder-style feedback.
//
// Every title is a sparse feature vector (genres, keywords, people, language,
// decade, type). Your taste is one vector too, built from:
//   - Netflix viewing history (recency-decayed, more episodes = stronger)
//   - swipes: right adds the title's features, super-like adds them twice,
//     left subtracts a little and hides the title forever.
// The deck is sampled from the best-scoring titles (score = similarity +
// IMDb quality) with a little exploration mixed in, the same way Tinder mixes
// "likely matches" with fresh profiles so the stack never feels repetitive.

export const WEIGHTS = {
  genre: 1.0,
  keyword: 0.6,
  creator: 0.8,
  cast: 0.45,
  language: 0.35,
  type: 0.3,
  decade: 0.2,
  format: 0.9, // stand-up specials and concerts are a taste of their own, not just "comedy" or "music"
};

export const TUNING = {
  historyWeight: 4, // the whole watch history counts like ~4 right swipes
  historyHalfLifeDays: 365,
  like: 1,
  superLike: 2,
  later: 0.25, // "think about it later" is a mild yes
  nope: -0.7,
  qualityWeight: 0.3,
  rewatchFactor: 0.3, // watched titles are drawn ~3x less often than new ones
  temperature: 0.08,
  poolSize: 60,
  exploreRate: 0.12,
  luckyMinRating: 7.5,
  trendingWeight: 0.15, // what's hot on Netflix right now nudges the score; taste still dominates
  dailyPickCount: 5,
  dailyPoolSize: 25,
};

const featureCache = new WeakMap();

/** L2-normalised sparse feature vector of a title. */
export function featuresOf(t) {
  if (featureCache.has(t)) return featureCache.get(t);
  const f = new Map();
  const add = (k, w) => f.set(k, (f.get(k) || 0) + w);
  for (const g of t.genres || []) add(`g:${g.toLowerCase()}`, WEIGHTS.genre);
  for (const k of (t.keywords || []).slice(0, 15)) add(`k:${k.toLowerCase()}`, WEIGHTS.keyword);
  for (const c of (t.creators || []).slice(0, 3)) add(`c:${c}`, WEIGHTS.creator);
  for (const c of (t.cast || []).slice(0, 5)) add(`p:${c}`, WEIGHTS.cast);
  if (t.format) add(`f:${t.format}`, WEIGHTS.format);
  if (t.language) add(`l:${t.language}`, WEIGHTS.language);
  if (t.type) add(`t:${t.type}`, WEIGHTS.type);
  if (t.year) add(`d:${Math.floor(t.year / 10) * 10}s`, WEIGHTS.decade);
  const norm = Math.sqrt([...f.values()].reduce((s, v) => s + v * v, 0)) || 1;
  for (const [k, v] of f) f.set(k, v / norm);
  featureCache.set(t, f);
  return f;
}

function addScaled(target, vec, scale) {
  for (const [k, v] of vec) target.set(k, (target.get(k) || 0) + v * scale);
}

function dot(a, b) {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [k, v] of small) {
    const w = big.get(k);
    if (w) s += v * w;
  }
  return s;
}

function normalize(vec) {
  const norm = Math.sqrt([...vec.values()].reduce((s, v) => s + v * v, 0));
  if (!norm) return vec;
  const out = new Map();
  for (const [k, v] of vec) out.set(k, v / norm);
  return out;
}

const DAY = 86400000;

/**
 * @param byId     Map id -> title
 * @param watched  [{titleId, views, lastWatched}] history resolved to titles
 * @param swipes   [{id, action: 'like'|'super'|'nope'}]
 */
export function buildProfile({ byId, watched = [], swipes = [], now = Date.now() }) {
  const history = new Map();
  const anchors = [];
  for (const w of watched) {
    const t = byId.get(w.titleId);
    if (!t) continue;
    const ageDays = w.lastWatched ? Math.max(0, (now - Date.parse(w.lastWatched)) / DAY) : 365;
    const recency = Math.pow(0.5, ageDays / TUNING.historyHalfLifeDays);
    const engagement = 1 + Math.log2(Math.max(1, w.views || 1));
    const weight = recency * engagement;
    addScaled(history, featuresOf(t), weight);
    anchors.push({ id: t.id, title: t.title, weight, source: 'watched' });
  }

  const vector = new Map();
  if (history.size) addScaled(vector, normalize(history), TUNING.historyWeight);

  for (const s of swipes) {
    const t = byId.get(s.id);
    if (!t) continue;
    const scale = s.action === 'super' ? TUNING.superLike : s.action === 'like' ? TUNING.like : s.action === 'later' ? TUNING.later : TUNING.nope;
    addScaled(vector, featuresOf(t), scale);
    if (s.action === 'like' || s.action === 'super') anchors.push({ id: t.id, title: t.title, weight: scale * 2, source: s.action === 'super' ? 'superliked' : 'liked' });
  }

  return { vector: normalize(vector), anchors, byId, empty: vector.size === 0 };
}

/** IMDb rating, or TMDB's score when IMDb has none. */
export const ratingOf = (t) => t.imdbRating ?? t.tmdbRating ?? null;

function quality(t) {
  const r = ratingOf(t);
  if (r == null) return 0;
  return Math.max(-1, Math.min(1, (r - 6.5) / 2.5));
}

/** 0..1 "hot right now" signal set by catalog.applyTrending (1 = top of Netflix's trending list). */
export const trendOf = (t) => Math.max(0, Math.min(1, t.trend || 0));

export function scoreTitle(profile, t) {
  const sim = profile.empty ? 0 : dot(profile.vector, featuresOf(t));
  const votes = t.imdbVotes ? Math.min(1, Math.log10(t.imdbVotes) / 6) : 0.5;
  return sim + TUNING.qualityWeight * quality(t) * votes + TUNING.trendingWeight * trendOf(t);
}

/** Which liked/watched title a recommendation is most like (for the card's "Because you…" line). */
export function explain(profile, t) {
  let best = null;
  let bestSim = 0.25;
  for (const a of profile.anchors) {
    if (a.id === t.id) continue;
    const sim = dot(featuresOf(t), featuresOf(profile.byId.get(a.id)));
    const s = sim * Math.min(2, 0.5 + a.weight);
    if (s > bestSim) { bestSim = s; best = a; }
  }
  if (best) {
    const verb = best.source === 'watched' ? 'watched' : best.source === 'superliked' ? 'loved' : 'liked';
    return { kind: 'similar', text: `Because you ${verb} ${best.title}`, anchorId: best.id };
  }
  if (trendOf(t) >= 0.6) return { kind: 'trending', text: 'Trending on Netflix now' };
  if ((ratingOf(t) || 0) >= 8) return { kind: 'rated', text: `Rated ${ratingOf(t)} on ${t.imdbRating != null ? 'IMDb' : 'TMDB'}` };
  return { kind: 'popular', text: 'Popular on Netflix' };
}

/** Titles that may appear in the deck given the user's settings. */
export function candidates({ catalog, swipedIds, excludeIds = new Set(), watchedIds, settings }) {
  const { includeWatched = false, types = 'both', minRating = 0, anywhere = false } = settings || {};
  return catalog.filter((t) => {
    if (swipedIds.has(t.id) || excludeIds.has(t.id)) return false;
    if (t.onNetflix === false && !anywhere) return false; // not on Netflix here: only when the person asked for titles from anywhere
    if (types !== 'both' && t.type !== types) return false;
    if (minRating && (ratingOf(t) ?? 0) < minRating) return false;
    if (!includeWatched && watchedIds.has(t.id)) return false;
    return true;
  });
}

function weightedPick(items, weights, rng) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return items.length - 1;
}

/**
 * Next n cards. Sampling (not a strict top-n) keeps the stack fresh; watched
 * titles have their sampling weight multiplied by rewatchFactor.
 */
export function nextDeck({ catalog, profile, swipedIds, excludeIds, watchedIds, settings, n = 10, rng = Math.random }) {
  const pool = candidates({ catalog, swipedIds, excludeIds, watchedIds, settings })
    .map((t) => ({ t, score: scoreTitle(profile, t) }))
    .sort((a, b) => b.score - a.score);
  const top = pool.slice(0, TUNING.poolSize);
  const rest = pool.slice(TUNING.poolSize).filter((p) => (ratingOf(p.t) ?? 0) >= 7);
  const deck = [];
  while (deck.length < n && (top.length || rest.length)) {
    let picked;
    let exploring = false;
    if (rest.length && (rng() < TUNING.exploreRate || !top.length)) {
      picked = rest.splice(Math.floor(rng() * rest.length), 1)[0];
      exploring = true;
    } else {
      const max = top[0].score;
      const weights = top.map((p) => Math.exp((p.score - max) / TUNING.temperature) * (watchedIds.has(p.t.id) ? TUNING.rewatchFactor : 1));
      picked = top.splice(weightedPick(top, weights, rng), 1)[0];
    }
    deck.push(decorate(profile, picked.t, { watchedIds, exploring, score: picked.score }));
  }
  return deck;
}

/**
 * "I'm feeling lucky": one high-rated title that fits the profile best.
 * Picks among the top 3 so pressing it twice can give a different answer.
 */
export function feelingLucky({ catalog, profile, swipedIds, excludeIds, watchedIds, settings, rng = Math.random }) {
  const pool = candidates({ catalog, swipedIds, excludeIds, watchedIds, settings: { ...settings, minRating: 0 } });
  for (const min of [TUNING.luckyMinRating, 7, 0]) {
    const good = pool
      .filter((t) => (ratingOf(t) ?? 0) >= min)
      .map((t) => {
        const s = scoreTitle(profile, t) + TUNING.qualityWeight * quality(t);
        return { t, s: watchedIds.has(t.id) ? s - 0.5 : s };
      })
      .sort((a, b) => b.s - a.s);
    if (good.length) {
      const pick = good[Math.floor(rng() * Math.min(3, good.length))];
      return decorate(profile, pick.t, { watchedIds, score: pick.s });
    }
  }
  return null;
}

/** Small deterministic PRNG so a given seed (e.g. today's date) always gives the same sequence. */
export function seededRng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * "Today's picks": a short, highly rated list that fits your taste and what's hot.
 * The list is the same all day (seeded by the date) and changes tomorrow.
 * `date` is a YYYY-MM-DD string.
 */
export function dailyPicks({ catalog, profile, swipedIds, excludeIds, watchedIds, settings, date, n = TUNING.dailyPickCount }) {
  const rng = seededRng(date);
  const pool = candidates({ catalog, swipedIds, excludeIds, watchedIds, settings: { ...settings, includeWatched: false, minRating: Math.max(settings?.minRating || 0, 7) } })
    .map((t) => ({ t, score: scoreTitle(profile, t) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TUNING.dailyPoolSize);
  const picks = [];
  while (picks.length < n && pool.length) {
    const max = pool[0].score;
    const weights = pool.map((p) => Math.exp((p.score - max) / TUNING.temperature));
    const [picked] = pool.splice(weightedPick(pool, weights, rng), 1);
    picks.push(decorate(profile, picked.t, { watchedIds, score: picked.score }));
  }
  return picks;
}

function decorate(profile, t, { watchedIds, exploring = false, score }) {
  const reason = exploring ? { kind: 'explore', text: 'Something different for you' } : explain(profile, t);
  return { ...t, watched: watchedIds.has(t.id), reason, score: Math.round(score * 1000) / 1000 };
}

/** Top features of a profile, for the "Your taste" panel. */
export function topTastes(profile, limit = 8) {
  const out = { genres: [], keywords: [] };
  const sorted = [...profile.vector].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    if (k.startsWith('g:') && out.genres.length < limit) out.genres.push({ name: k.slice(2), weight: v });
    if (k.startsWith('k:') && out.keywords.length < limit) out.keywords.push({ name: k.slice(2), weight: v });
  }
  return out;
}
