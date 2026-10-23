// One Durable Object holds everything that is shared between people and must be consistent:
// TMDB lookups (so each title costs one lookup in total), watched-but-no-longer-on-Netflix titles,
// catalog build status, rate-limit counters and device-transfer codes.
// It never holds anyone's viewing history or swipes.
import { DurableObject } from 'cloudflare:workers';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const TRANSFER_TTL = 10 * 60 * 1000;
const MAX_TRANSFERS = 500;

export class Shared extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS search (key TEXT PRIMARY KEY, hit TEXT);
      CREATE TABLE IF NOT EXISTS titles (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (region TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers (code TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS buckets (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
    `);
  }

  // ---- shared TMDB lookups ----
  /** {key: {kind,id}|null} for the keys we already know. A key that is missing is unknown. */
  getSearch(keys) {
    const out = {};
    for (let i = 0; i < keys.length; i += 50) {
      const part = keys.slice(i, i + 50);
      const rows = this.sql.exec(`SELECT key, hit FROM search WHERE key IN (${part.map(() => '?').join(',')})`, ...part).toArray();
      for (const r of rows) out[r.key] = r.hit ? JSON.parse(r.hit) : null;
    }
    return out;
  }

  putSearch(entries) {
    for (const [key, hit] of Object.entries(entries)) {
      this.sql.exec('INSERT OR REPLACE INTO search (key, hit) VALUES (?, ?)', key, hit ? JSON.stringify(hit) : null);
    }
  }

  getTitles(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      for (const r of this.sql.exec(`SELECT json FROM titles WHERE id IN (${part.map(() => '?').join(',')})`, ...part)) out.push(JSON.parse(r.json));
    }
    return out;
  }

  putTitles(titles) {
    for (const t of titles) this.sql.exec('INSERT OR REPLACE INTO titles (id, json) VALUES (?, ?)', t.id, JSON.stringify(t));
  }

  // ---- catalog build status ----
  jobGet(region) {
    const row = this.sql.exec('SELECT json, updated FROM jobs WHERE region = ?', region).toArray()[0];
    return row ? { ...JSON.parse(row.json), updated: row.updated } : { state: 'idle' };
  }

  jobSet(region, job) {
    this.sql.exec('INSERT OR REPLACE INTO jobs (region, json, updated) VALUES (?, ?, ?)', region, JSON.stringify(job), Date.now());
  }

  regionsBuilt() {
    return this.sql.exec('SELECT region FROM jobs').toArray().map((r) => r.region).filter((r) => this.jobGet(r).state !== 'error');
  }

  /** Starts a catalog build for a region unless one is already running (or just failed). Returns the job. */
  async ensureBuild(region, force = false) {
    const job = this.jobGet(region);
    const age = Date.now() - (job.updated || 0);
    if (job.state === 'running' && age < 20 * 60 * 1000) return job; // a crashed run is retried after 20 minutes
    if (!force && job.state === 'error' && age < 10 * 60 * 1000) return job; // don't hammer TMDB after a failure
    this.jobSet(region, { state: 'running', message: 'Waiting for its turn…', progress: 0 });
    await this.env.BUILD.create({ id: `build-${region}-${Date.now()}`, params: { region } });
    return this.jobGet(region);
  }

  // ---- rate limiting (only for the expensive endpoints) ----
  limit(key, max, windowMs) {
    const now = Date.now();
    const row = this.sql.exec('SELECT start, count FROM buckets WHERE key = ?', key).toArray()[0];
    if (!row || now - row.start >= windowMs) {
      this.sql.exec('INSERT OR REPLACE INTO buckets (key, start, count) VALUES (?, ?, 1)', key, now);
      this.sql.exec('DELETE FROM buckets WHERE start < ?', now - 3600000);
      return true;
    }
    this.sql.exec('UPDATE buckets SET count = count + 1 WHERE key = ?', key);
    return row.count + 1 <= max;
  }

  // ---- device-to-device transfer codes: held 10 minutes, handed over once, then deleted ----
  transferCreate(payload) {
    const now = Date.now();
    this.sql.exec('DELETE FROM transfers WHERE expires < ?', now);
    if (this.sql.exec('SELECT COUNT(*) AS n FROM transfers').toArray()[0].n >= MAX_TRANSFERS) return null;
    const code = newCode();
    this.sql.exec('INSERT INTO transfers (code, payload, expires) VALUES (?, ?, ?)', code, payload, now + TRANSFER_TTL);
    return code;
  }

  transferClaim(code) {
    const row = this.sql.exec('SELECT payload, expires FROM transfers WHERE code = ?', code).toArray()[0];
    if (!row) return null;
    this.sql.exec('DELETE FROM transfers WHERE code = ?', code);
    return Date.now() > row.expires ? null : row.payload;
  }
}
