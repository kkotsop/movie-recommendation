// One Durable Object holds the two things that must be consistent across everyone: counters that stop
// code-guessing, and one-time device-transfer codes. It never holds anyone's viewing history or swipes
// (a transfer code holds the data a person chose to move, for ten minutes, until it is collected).
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
      CREATE TABLE IF NOT EXISTS transfers (code TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS buckets (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
    `);
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
