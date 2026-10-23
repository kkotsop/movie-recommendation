// Parses Netflix "Viewing activity" exports (NetflixViewingHistory.csv) and
// groups the per-episode rows into shows/movies the recommender can use.

// Words Netflix uses for the season/part segment of an episode title, in the
// languages Netflix localises the export into most often.
const SEASON_MARKERS = [
  'season', 'series', 'limited series', 'miniseries', 'part', 'volume', 'vol\\.', 'chapter',
  'book', 'collection', 'episode', 'temporada', 'staffel', 'saison', 'stagione', 'seizoen',
  'sezon', 'säsong', 'sæson', 'sesong', 'kausi', 'évad', 'série', 'serie', 'parte', 'teil',
  'σεζόν', 'κύκλος', 'μέρος', 'сезон', 'シーズン', '시즌', '第',
];
const MARKER_RE = new RegExp(`^(${SEASON_MARKERS.join('|')})(\\s|\\d|:|$)`, 'i');
const TRAILING_NUMBER_RE = /^(.+?)\s*(\d{1,2}|[IVX]{1,4})$/;

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

// Netflix writes dates in the account's locale: 12/25/22 (US) or 25/12/2022.
// Decide the order once per file: any first part > 12 means day-first.
function detectDayFirst(dates) {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const d of dates) {
    const p = d.split(/[/.\-]/).map(Number);
    if (p.length !== 3 || p[0] > 31) continue;
    if (p[0] > 12) dayFirst++;
    else if (p[1] > 12) monthFirst++;
  }
  return dayFirst > monthFirst;
}

function parseDate(s, dayFirst) {
  const p = s.trim().split(/[/.\-]/).map(Number);
  if (p.length !== 3 || p.some(Number.isNaN)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  }
  let y, m, d;
  if (p[0] > 31) [y, m, d] = p; // ISO-like 2024-05-01
  else if (dayFirst) [d, m, y] = p;
  else [m, d, y] = p;
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Turns CSV text into [{title, date}] (date as YYYY-MM-DD or null). */
export function parseViewingHistoryCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let titleCol = header.indexOf('title');
  let dateCol = header.indexOf('date');
  let body = rows.slice(1);
  const headerless = titleCol === -1;
  if (headerless) { titleCol = 0; dateCol = 1; body = rows; }
  const picked = body.map((r) => ({ title: r[titleCol], date: dateCol >= 0 ? r[dateCol] : '' }));
  // A localized header ("Τίτλος,Ημερομηνία") is fine, but a random spreadsheet is not: most rows need a date like 28/09/2026.
  const dateShaped = (d) => /^\s*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\s*$/.test(d || '');
  if (headerless && picked.filter((r) => dateShaped(r.date)).length < picked.length / 2) return [];
  return entriesFromRows(picked);
}

/** [{title, date: raw locale string}] -> [{title, date: YYYY-MM-DD|null}] */
export function entriesFromRows(rows) {
  const dayFirst = detectDayFirst(rows.map((r) => r.date || ''));
  return rows
    .filter((r) => (r.title || '').trim())
    .map((r) => ({ title: r.title.trim(), date: r.date ? parseDate(r.date, dayFirst) : null }));
}

/**
 * Splits "Show: Season 2: Episode name" into a series name, or returns null when
 * the title doesn't carry a season marker.
 */
export function seriesNameFromTitle(title) {
  const parts = title.split(': ');
  if (parts.length < 2) return null;
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (MARKER_RE.test(seg)) return parts.slice(0, i).join(': ');
    // "Stranger Things: Stranger Things 4: Chapter One"
    const num = seg.match(TRAILING_NUMBER_RE);
    if (num && normalizeTitle(num[1]) === normalizeTitle(parts.slice(0, i).join(': '))) {
      return parts.slice(0, i).join(': ');
    }
  }
  return null;
}

export function normalizeTitle(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Groups viewing rows into titles:
 * [{name, kind: 'series'|'movie', views, firstWatched, lastWatched}]
 * sorted by most recently watched.
 */
export function groupHistory(entries) {
  const confident = new Set();
  const firstSegCount = new Map();
  for (const e of entries) {
    const s = seriesNameFromTitle(e.title);
    if (s) confident.add(s);
    const parts = e.title.split(': ');
    if (parts.length >= 2) firstSegCount.set(parts[0], (firstSegCount.get(parts[0]) || 0) + 1);
  }

  const groups = new Map();
  for (const e of entries) {
    let name = seriesNameFromTitle(e.title);
    let kind = 'series';
    if (!name) {
      const parts = e.title.split(': ');
      if (parts.length >= 3 || (parts.length === 2 && (confident.has(parts[0]) || firstSegCount.get(parts[0]) >= 3))) {
        name = parts[0];
      } else {
        // "Mission: Impossible - Fallout", "Roma": a single film
        name = e.title;
        kind = 'movie';
      }
    }
    const key = normalizeTitle(name);
    const g = groups.get(key) || { name, kind, views: 0, firstWatched: null, lastWatched: null };
    g.views++;
    if (kind === 'series') g.kind = 'series';
    if (e.date) {
      if (!g.firstWatched || e.date < g.firstWatched) g.firstWatched = e.date;
      if (!g.lastWatched || e.date > g.lastWatched) g.lastWatched = e.date;
    }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (b.lastWatched || '').localeCompare(a.lastWatched || ''));
}
