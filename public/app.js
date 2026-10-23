// Swipeflix client: a card stack for deciding what to watch. Everything personal stays on this phone.
import * as device from './device-store.js';
import * as engine from './lib/engine.js';
import { REGIONS } from './lib/regions.js';
import { parseViewingHistoryCsv, groupHistory } from './lib/history.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const api = {
  async req(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body == null ? {} : { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || `Request failed (${res.status})`), { status: res.status });
    return out;
  },
  post: (p, b = {}) => api.req('POST', p, b),
};

const S = {
  state: null,
  catalog: null, // the country's catalog (or the built-in sample), held in memory and scored on this phone
  queue: [], // cards in the stack, queue[0] is on top
  swipedThisSession: new Set(),
  refilling: false,
  likesFilter: 'all',
  likes: [],
  daily: [],
  detailFor: null, // {card, from: 'daily'|'likes'}
  swipeCount: 0,
};

const data = () => device.data();

// ---------------------------------------------------------------- the catalog (scored on this phone)

let demoRaw;
async function fetchCatalogFile(code) {
  try {
    const res = await fetch(`/api/catalog/${code}`);
    if (res.ok) return await res.json();
  } catch { /* offline, or not built yet */ }
  return null;
}

/**
 * The country's catalog if it has been built, otherwise the built-in sample. The worldwide list (titles from other
 * services, stand-up, concerts) is added when the person wants those, and to recognise more of what they've watched.
 */
async function loadCatalog() {
  const d = data();
  const needAll = d.settings.anywhere || Boolean(d.history?.groups?.length);
  const [file, all] = await Promise.all([fetchCatalogFile(d.settings.region), needAll ? fetchCatalogFile('ALL') : null]);
  let base;
  if (file) base = engine.makeCatalog('tmdb', file.titles, file.builtAt);
  else {
    try {
      demoRaw ||= await (await fetch('/demo-catalog.json')).json();
      base = engine.demoCatalog(demoRaw);
    } catch {
      base = engine.makeCatalog('demo', []);
      toast("Couldn't load titles. Check your connection.");
    }
  }
  S.catalog = all ? engine.mergeCatalogs(base, { titles: all.titles }) : base;
  return S.catalog;
}

// ---------------------------------------------------------------- formatting

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (id, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}"><use href="#i-${id}"/></svg>`;
const FORMAT_LABEL = { standup: 'Stand-up', concert: 'Concert' };

function hue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

const kindLabel = (t) => FORMAT_LABEL[t.format] || (t.type === 'series' ? 'Series' : 'Movie');

function ratingHtml(t) {
  if (t.imdbRating != null) return `<span class="rating"><b>IMDb</b>${t.imdbRating.toFixed(1)}</span>`;
  if (t.tmdbRating) return `<span class="rating"><b>TMDB</b>${t.tmdbRating.toFixed(1)}</span>`;
  return '';
}

function lengthText(t) {
  if (t.type === 'series') {
    if (t.seasons) return `${t.seasons} season${t.seasons > 1 ? 's' : ''}`;
    return t.endYear && t.endYear !== t.year ? `${t.year}–${t.endYear}` : '';
  }
  if (!t.runtime) return '';
  const h = Math.floor(t.runtime / 60);
  return h ? `${h}h ${t.runtime % 60}m` : `${t.runtime}m`;
}

function metaHtml(t) {
  const len = lengthText(t);
  return `<div class="card-meta">${ratingHtml(t)}<span>${kindLabel(t)}</span>${len ? `<span>·</span><span>${esc(len)}</span>` : ''}</div>`;
}

/** A page background: the real poster, or a plain typographic poster when there is none. */
function pageHtml(t, extraCls = '') {
  if (t.poster) return `<div class="card-page ${extraCls}" style="background-image:url('${esc(t.poster)}')"></div>`;
  return `<div class="card-page poster-gen ${extraCls}" style="--h:${hue(t.title)}"></div>`;
}

function chipsHtml(t, max = 2) {
  const chips = [];
  if (t.format) chips.push(`<span class="chip format">${FORMAT_LABEL[t.format]}</span>`);
  if (t.onNetflix === false) chips.push('<span class="chip elsewhere">Not on Netflix</span>');
  if (t.watched) chips.push('<span class="chip watched">Rewatch</span>');
  for (const g of (t.genres || []).slice(0, max)) chips.push(`<span class="chip">${esc(g)}</span>`);
  return `<div class="chips">${chips.join('')}</div>`;
}

function peopleLine(t) {
  const lines = [];
  if (t.creators?.length) lines.push(`<li>${t.type === 'series' ? 'Created by' : 'Directed by'} <b>${esc(t.creators.join(', '))}</b></li>`);
  if (t.cast?.length) lines.push(`<li>Starring <b>${esc(t.cast.slice(0, 3).join(', '))}</b></li>`);
  return lines.join('');
}

/** Where to watch: Netflix when it's there, otherwise a lookup of every service in the person's country. */
function watchLink(t, cls = '') {
  if (t.onNetflix === false) {
    const region = (data().settings.region || 'us').toLowerCase();
    return `<a class="${cls}" href="https://www.justwatch.com/${region}/search?q=${encodeURIComponent(t.title)}" target="_blank" rel="noopener">${icon('play')} Where to watch</a>`;
  }
  return `<a class="${cls}" href="${esc(t.netflixUrl)}" target="_blank" rel="noopener">${icon('play')} Watch on Netflix</a>`;
}

function imdbLink(t, cls = 'plain') {
  return t.imdbId ? `<a class="${cls}" href="https://www.imdb.com/title/${esc(t.imdbId)}/" target="_blank" rel="noopener">IMDb</a>` : '';
}

/** Two pages: the poster, then everything else on one calm page. */
function cardHtml(t) {
  const title = `<h2>${esc(t.title)}<span class="year">${t.year || ''}</span></h2>`;
  return `
    <div class="card-face on" data-face="0">
      ${pageHtml(t)}
      <div class="card-shade"></div>
      <div class="card-info">
        ${title}${metaHtml(t)}
        <div class="reason">${esc(t.reason?.text || '')}</div>
        ${chipsHtml(t)}
      </div>
    </div>
    <div class="card-face" data-face="1">
      <div class="card-back">
        ${title}
        <p class="card-overview">${esc(t.overview || 'No description yet.')}</p>
        <div class="why"><b>Why it's here:</b> ${esc(t.reason?.text || 'Picked for you')}</div>
        <ul class="facts">
          ${peopleLine(t)}
          ${t.imdbVotes ? `<li><b>${t.imdbRating}</b> on IMDb from ${Number(t.imdbVotes).toLocaleString()} votes</li>` : ''}
        </ul>
        <div class="chips">${(t.keywords || []).slice(0, 5).map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div>
        <div class="card-links">${watchLink(t)}${imdbLink(t)}</div>
      </div>
    </div>
    <div class="card-bars"><span class="on"></span><span></span></div>
    <div class="stamp stamp-like">Like</div>
    <div class="stamp stamp-nope">Nope</div>
    <div class="stamp stamp-super">Must<br>watch</div>
    <div class="stamp stamp-later">Later</div>`;
}

// ---------------------------------------------------------------- the stack

const deckEl = $('#deck');

function cardEl(id) {
  return $$('.card', deckEl).find((el) => el.dataset.id === id);
}

function topCard() {
  return S.queue[0] ? cardEl(S.queue[0].id) : null;
}

/** Keeps DOM cards for queue[0..2] and marks top / next / behind. */
function layoutDeck() {
  const visible = S.queue.slice(0, 3);
  const keep = new Set(visible.map((c) => c.id));
  $$('.card', deckEl).forEach((el) => { if (!keep.has(el.dataset.id) && !el.classList.contains('fly')) el.remove(); });
  [...visible].reverse().forEach((c) => {
    const i = visible.indexOf(c);
    let el = cardEl(c.id);
    if (!el) {
      el = document.createElement('article');
      el.className = 'card';
      el.dataset.id = c.id;
      el.dataset.page = '0';
      el.setAttribute('aria-label', `${c.title} (${c.year || ''})`);
      el.innerHTML = cardHtml(c);
      deckEl.prepend(el);
      bindDrag(el);
    }
    el.style.zIndex = String(10 - i);
    el.classList.toggle('is-next', i === 1);
    el.classList.toggle('is-behind', i === 2);
    if (i === 0) el.style.removeProperty('transform');
  });
  updateEmptyState();
  $('[data-action="rewind"]').disabled = !data().swipes.length;
}

function updateEmptyState() {
  const radar = $('#radar');
  const empty = !S.queue.length;
  radar.hidden = !empty;
  $('#actions').style.visibility = empty ? 'hidden' : '';
  if (radar.hidden) return;
  $('#radar-text').textContent = S.refilling ? 'Finding titles for you…' : "You've seen everything that matches what you asked for. Try changing what you see, or let luck decide.";
  $('#radar-actions').hidden = S.refilling;
}

async function refill(reset = false) {
  if (reset) {
    S.queue = [];
    $$('.card', deckEl).forEach((el) => el.remove());
  }
  if (S.refilling) return;
  S.refilling = true;
  updateEmptyState();
  try {
    const exclude = [...S.queue.map((c) => c.id), ...S.swipedThisSession];
    const cards = engine.deck(S.catalog, data(), { n: 10, exclude });
    const have = new Set(S.queue.map((c) => c.id));
    S.queue.push(...cards.filter((c) => !have.has(c.id)));
  } catch (err) {
    toast(err.message);
  } finally {
    S.refilling = false;
    layoutDeck();
  }
}

// ---------------------------------------------------------------- gestures

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

function paintDrag(el, dx, dy, grabTop) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const rot = (dx / w) * 18 * (grabTop ? 1 : -1);
  el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
  const vertical = Math.abs(dy) > Math.abs(dx);
  const like = vertical ? 0 : clamp(dx / (w * 0.25));
  const nope = vertical ? 0 : clamp(-dx / (w * 0.25));
  const up = vertical && dy < 0 ? clamp(-dy / (h * 0.18)) : 0;
  const down = vertical && dy > 0 ? clamp(dy / (h * 0.18)) : 0;
  $('.stamp-like', el).style.opacity = like;
  $('.stamp-nope', el).style.opacity = nope;
  $('.stamp-super', el).style.opacity = up;
  $('.stamp-later', el).style.opacity = down;
  $('.act-like').classList.toggle('lit', like > 0.6);
  $('.act-nope').classList.toggle('lit', nope > 0.6);
  const next = S.queue[1] && cardEl(S.queue[1].id);
  if (next) {
    next.style.transition = 'none';
    next.style.transform = `scale(${0.96 + 0.04 * clamp(Math.hypot(dx, dy) / (w * 0.5))})`;
  }
}

function clearLit() {
  $$('.act').forEach((b) => b.classList.remove('lit'));
}

function bindDrag(el) {
  let active = false;
  let sx, sy, dx, dy, t0, lastX, lastY, lastT, vx, vy, grabTop;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || el !== topCard() || e.target.closest('a')) return;
    active = true;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    sx = lastX = e.clientX;
    sy = lastY = e.clientY;
    t0 = lastT = performance.now();
    dx = dy = vx = vy = 0;
    grabTop = e.clientY - r.top < r.height / 2;
    el.classList.remove('spring');
    el.classList.add('dragging');
  });

  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    vx = 0.8 * ((e.clientX - lastX) / dt) + 0.2 * vx;
    vy = 0.8 * ((e.clientY - lastY) / dt) + 0.2 * vy;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = now;
    dx = e.clientX - sx;
    dy = e.clientY - sy;
    paintDrag(el, dx, dy, grabTop);
  });

  const end = (e) => {
    if (!active) return;
    active = false;
    el.classList.remove('dragging');
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (Math.hypot(dx, dy) < 8 && performance.now() - t0 < 400) {
      resetDrag(el);
      return onTap(el, e);
    }
    const vertical = Math.abs(dy) > Math.abs(dx);
    let action = null;
    if (vertical && -dy > h * 0.22) action = 'super';
    else if (vertical && dy > h * 0.22) action = 'later';
    else if (dx > w * 0.35 || (vx > 0.6 && dx > 30)) action = 'like';
    else if (dx < -w * 0.35 || (vx < -0.6 && dx < -30)) action = 'nope';
    if (action) flyOut(el, action, { dx, dy, vx, vy });
    else resetDrag(el, true);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function resetDrag(el, spring = false) {
  if (spring) el.classList.add('spring');
  el.style.transform = '';
  $$('.stamp', el).forEach((s) => (s.style.opacity = 0));
  const next = S.queue[1] && cardEl(S.queue[1].id);
  if (next) {
    next.style.transition = '';
    next.style.transform = '';
  }
  clearLit();
}

function onTap(el, e) {
  const r = el.getBoundingClientRect();
  stepPage(el, e.clientX < r.left + r.width / 2 ? -1 : 1);
}

/** Two pages: tap the right side for the details, the left side to go back to the poster. */
function stepPage(el, dir) {
  const faces = $$('.card-face', el);
  const next = Number(el.dataset.page) + dir;
  if (next < 0 || next >= faces.length) {
    el.animate([{ transform: 'none' }, { transform: `translateX(${dir * 6}px)` }, { transform: 'none' }], { duration: 160 });
    return;
  }
  el.dataset.page = String(next);
  faces.forEach((f, i) => f.classList.toggle('on', i === next));
  $$('.card-bars span', el).forEach((b, i) => b.classList.toggle('on', i === next));
}

function flyOut(el, action, { dx = 0, dy = 0, vy = 0 } = {}) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const W = window.innerWidth;
  let x, y, rot;
  if (action === 'super' || action === 'later') {
    x = dx;
    y = (action === 'super' ? -1 : 1) * (window.innerHeight + h);
    rot = (dx / w) * 12;
  } else {
    const dir = action === 'like' ? 1 : -1;
    x = dir * (W / 2 + w * 1.2);
    y = dy + vy * 150;
    rot = dir * 26;
  }
  $(`.stamp-${action}`, el).style.opacity = 1;
  el.classList.remove('spring');
  el.classList.add('fly');
  el.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
  setTimeout(() => el.remove(), 400);
  commitSwipe(action);
}

function swipeTop(action) {
  const el = topCard();
  if (!el || el.classList.contains('fly')) return;
  const btn = $(`.act-${action}`);
  if (btn) { btn.classList.add('pressed', 'lit'); setTimeout(() => btn.classList.remove('pressed', 'lit'), 220); }
  const nudge = { like: [40, 0], nope: [-40, 0], super: [0, -40], later: [0, 40] }[action];
  paintDrag(el, nudge[0], nudge[1], true);
  requestAnimationFrame(() => flyOut(el, action));
}

const SAVED_TOAST = { super: 'Added to Must watch', later: 'Saved for later' };

async function commitSwipe(action) {
  const card = S.queue.shift();
  if (!card) return;
  clearLit();
  const next = S.queue[0] && cardEl(S.queue[0].id);
  if (next) {
    next.style.transition = '';
    next.style.transform = '';
  }
  S.swipedThisSession.add(card.id);
  S.swipeCount++;
  if (S.swipeCount >= 3) hideCoach();
  if (SAVED_TOAST[action]) toast(`${SAVED_TOAST[action]}: ${card.title}`);
  device.addSwipe(card.id, action);
  Object.assign(S.state.stats, device.counts());
  updateBadge();
  layoutDeck();
  if (S.queue.length < 5) refill();
}

async function rewind() {
  try {
    const last = device.popSwipe();
    if (!last) return toast('Nothing to rewind');
    const [card] = engine.cards(S.catalog, data(), [last.id]);
    if (!card) return;
    S.swipedThisSession.delete(card.id);
    S.queue = [card, ...S.queue.filter((c) => c.id !== card.id)];
    cardEl(card.id)?.remove();
    layoutDeck();
    const el = cardEl(card.id);
    const from = { like: 'translate(120%, 0) rotate(22deg)', nope: 'translate(-120%, 0) rotate(-22deg)', super: 'translate(0, -120%)', later: 'translate(0, 120%)' }[last.action];
    el.style.transform = from;
    el.getBoundingClientRect();
    el.classList.add('spring');
    el.style.transform = '';
    const btn = $('.act-rewind');
    btn.classList.add('lit');
    setTimeout(() => btn.classList.remove('lit'), 300);
    refreshState();
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- feeling lucky

async function feelingLucky(exclude = []) {
  hideCoach();
  const btn = $('.act-lucky');
  btn.classList.add('lit', 'pressed');
  setTimeout(() => btn.classList.remove('lit', 'pressed'), 250);
  try {
    const card = engine.lucky(S.catalog, data(), { exclude });
    if (!card) return toast('You have swiped through everything that matches what you asked for.');
    showPick(card, exclude);
  } catch (err) {
    toast(err.message);
  }
}

function showPick(t, tried) {
  const box = $('#match-inner');
  box.innerHTML = `
    <p class="match-title">Tonight's pick</p>
    <div class="match-poster">${pageHtml(t)}</div>
    <div class="match-name">${esc(t.title)} <span class="muted">${t.year || ''}</span></div>
    <div class="match-meta">${ratingHtml(t)}<span>${kindLabel(t)}</span>${lengthText(t) ? `<span>${esc(lengthText(t))}</span>` : ''}</div>
    <div class="match-reason">${esc(t.reason?.text || '')}</div>
    <div class="match-btns">
      ${watchLink(t, 'btn')}
      <button class="btn btn-secondary" data-pick="save">Save to Must watch</button>
      <button class="btn btn-secondary" data-pick="again">Another pick</button>
      <button class="btn-quiet" data-pick="close">Keep swiping</button>
    </div>`;
  $('#match').hidden = false;
  box.onclick = async (e) => {
    const what = e.target.closest('[data-pick]')?.dataset.pick;
    if (!what) return;
    if (what === 'close') return closePick();
    if (what === 'again') return feelingLucky([...tried, t.id]);
    if (what === 'save') {
      device.addSwipe(t.id, 'super');
      Object.assign(S.state.stats, device.counts());
      S.swipedThisSession.add(t.id);
      S.queue = S.queue.filter((c) => c.id !== t.id);
      cardEl(t.id)?.remove();
      layoutDeck();
      refreshState();
      toast(`Added to Must watch: ${t.title}`);
      closePick();
    }
  };
}

function closePick() {
  $('#match').hidden = true;
}

// ---------------------------------------------------------------- a title opened from a list

function openDetail(t, from) {
  if (!t) return;
  S.detailFor = { card: t, from };
  const saved = data().swipes.find((s) => s.id === t.id)?.action;
  const actions = from === 'daily'
    ? `<button class="btn btn-secondary" data-d="nope">Not for me</button><button class="btn btn-secondary" data-d="later">Later</button><button class="btn" data-d="like">Like</button>`
    : saved === 'later'
      ? `<button class="btn btn-secondary" data-d="remove">Remove</button><button class="btn btn-secondary" data-d="super">Must watch</button><button class="btn" data-d="like">Like</button>`
      : `<button class="btn btn-secondary" data-d="remove">Remove from saved</button>`;
  $('#detail').innerHTML = `
    <div class="detail-hero">${pageHtml(t)}
      <button class="detail-close" data-close aria-label="Close">${icon('down')}</button>
    </div>
    <div class="detail-content">
      <h1>${esc(t.title)}<span class="year">${t.year || ''}</span></h1>
      ${metaHtml(t)}
      ${t.reason?.text ? `<p class="muted">${esc(t.reason.text)}</p>` : ''}
      ${chipsHtml(t, 3)}
      ${watchLink(t, 'link-btn')}
      <div class="detail-section"><p>${t.tagline ? `<i>${esc(t.tagline)}</i><br>` : ''}${esc(t.overview || 'No description yet.')}</p></div>
      ${t.creators?.length || t.cast?.length ? `<div class="detail-section"><ul class="facts">${peopleLine(t)}</ul></div>` : ''}
      ${t.keywords?.length ? `<div class="detail-section"><div class="chips">${t.keywords.slice(0, 10).map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div></div>` : ''}
      ${t.imdbVotes ? `<div class="detail-section"><p><b>${t.imdbRating}</b>/10 on IMDb from ${Number(t.imdbVotes).toLocaleString()} votes${t.imdbId ? ` · <a href="https://www.imdb.com/title/${esc(t.imdbId)}/" target="_blank" rel="noopener">IMDb page</a>` : ''}</p></div>` : ''}
    </div>
    <div class="detail-actions">${actions}</div>`;
  openSheet('#sheet-detail');
}

$('#detail').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-d]')?.dataset.d;
  if (!d || !S.detailFor) return;
  const { card, from } = S.detailFor;
  closeSheets();
  if (d === 'remove') {
    device.removeSwipe(card.id);
    S.swipedThisSession.delete(card.id);
    toast(`Removed ${card.title}`);
  } else {
    device.addSwipe(card.id, d);
    S.swipedThisSession.add(card.id);
    S.queue = S.queue.filter((c) => c.id !== card.id);
    cardEl(card.id)?.remove();
    layoutDeck();
    toast(d === 'nope' ? `Won't show ${card.title} again` : d === 'later' ? `Saved for later: ${card.title}` : `Saved: ${card.title}`);
  }
  if (from === 'daily') { S.daily = S.daily.filter((c) => c.id !== card.id); renderDaily(); }
  await refreshState();
  if (from === 'likes') loadLikes();
});

// ---------------------------------------------------------------- sheets

function openSheet(sel) {
  $(sel).hidden = false;
}

function closeSheets() {
  $$('.sheet').forEach((s) => (s.hidden = true));
  S.detailFor = null;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheets();
});

// ---------------------------------------------------------------- what you see (in Profile)

$('#region').innerHTML = Object.entries(REGIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

function renderFilters() {
  const s = S.state.settings;
  $$('#types button').forEach((b) => b.classList.toggle('on', b.dataset.types === s.types));
  $('#include-watched').checked = s.includeWatched;
  $('#include-anywhere').checked = Boolean(s.anywhere);
  $('#min-rating').value = s.minRating;
  $('#min-rating-val').textContent = s.minRating ? `${s.minRating}+` : 'Any';
  $('#region').value = s.region;
}

async function saveSettings(patch, reloadDeck = true) {
  try {
    const d = data();
    const catalogChanged = ('region' in patch && patch.region !== d.settings.region) || ('anywhere' in patch && patch.anywhere !== d.settings.anywhere);
    Object.assign(d.settings, patch);
    device.save();
    if (catalogChanged) {
      await loadCatalog();
      if (d.settings.anywhere && !S.catalog.hasWorldwide) {
        d.settings.anywhere = false;
        device.save();
        toast("Titles from other services aren't available yet.");
      }
    }
    await refreshState();
    if (reloadDeck) refill(true);
  } catch (err) {
    toast(err.message);
  }
}

$('#types').addEventListener('click', (e) => {
  const b = e.target.closest('[data-types]');
  if (b) saveSettings({ types: b.dataset.types });
});
$('#include-watched').addEventListener('change', (e) => saveSettings({ includeWatched: e.target.checked }));
$('#include-anywhere').addEventListener('change', (e) => saveSettings({ anywhere: e.target.checked }));
$('#min-rating').addEventListener('input', (e) => ($('#min-rating-val').textContent = Number(e.target.value) ? `${e.target.value}+` : 'Any'));
$('#min-rating').addEventListener('change', (e) => saveSettings({ minRating: Number(e.target.value) }));
$('#region').addEventListener('change', (e) => saveSettings({ region: e.target.value }));

// ---------------------------------------------------------------- reset

async function resetSwipes() {
  if (!confirm('Reset all your swipes? Liked, Must watch, Later and Nope lists are cleared. Your Netflix history stays.')) return;
  device.resetSwipes();
  S.swipedThisSession.clear();
  await refreshState();
  toast('Fresh start. Swipes reset.');
  refill(true);
}

async function resetAll() {
  if (!confirm('Reset everything? This clears your swipes and imported Netflix history from this device.')) return;
  device.resetEverything();
  S.swipedThisSession.clear();
  await loadCatalog();
  await refreshState();
  showWelcome();
  refill(true);
}

// ---------------------------------------------------------------- saved

function loadLikes() {
  try {
    S.likes = engine.likes(S.catalog, data());
  } catch (err) {
    toast(err.message);
  }
  renderLikes();
}

const EMPTY_SAVED = {
  all: 'Titles you like show up here.',
  super: 'Swipe up on a title to mark it must-watch.',
  later: 'Swipe down on a title to decide later.',
};

function renderLikes() {
  const keep = { all: (l) => l.action === 'like' || l.action === 'super', super: (l) => l.action === 'super', later: (l) => l.action === 'later' }[S.likesFilter];
  const list = S.likes.filter(keep);
  $('#likes-grid').innerHTML = list.length
    ? list.map((t) => `
      <button class="like-card" data-id="${esc(t.id)}">
        ${pageHtml(t)}
        ${t.action === 'super' ? `<span class="lc-mark">${icon('star')}</span>` : ''}
        <span class="lc-info"><div class="lc-title">${esc(t.title)}</div><div class="lc-sub">${t.year || ''} · ${kindLabel(t)}${t.imdbRating ? ` · ${t.imdbRating.toFixed(1)}` : ''}</div></span>
      </button>`).join('')
    : `<div class="empty-note">${EMPTY_SAVED[S.likesFilter]}</div>`;
}

$('#likes-grid').addEventListener('click', (e) => {
  const id = e.target.closest('.like-card')?.dataset.id;
  if (id) openDetail(S.likes.find((l) => l.id === id), 'likes');
});
$('#likes-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  S.likesFilter = b.dataset.filter;
  $$('#likes-filter button').forEach((x) => x.classList.toggle('on', x === b));
  renderLikes();
});

// ---------------------------------------------------------------- today's picks

const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function loadDaily() {
  try {
    const date = localDate();
    S.daily = engine.daily(S.catalog, data(), date);
    $('#daily-date').textContent = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  } catch (err) {
    toast(err.message);
  }
  renderDaily();
}

function renderDaily() {
  $('#daily-grid').innerHTML = S.daily.length
    ? S.daily.map((t) => `
      <button class="like-card" data-id="${esc(t.id)}">
        ${pageHtml(t)}
        <span class="lc-info"><div class="lc-title">${esc(t.title)}</div><div class="lc-sub">${t.year || ''} · ${kindLabel(t)}${t.imdbRating ? ` · ${t.imdbRating.toFixed(1)}` : ''}</div><span class="lc-why">${esc(t.reason?.text || '')}</span></span>
      </button>`).join('')
    : "<div class=\"empty-note\">You're all caught up. Fresh picks arrive tomorrow.</div>";
}

$('#daily-grid').addEventListener('click', (e) => {
  const id = e.target.closest('.like-card')?.dataset.id;
  if (id) openDetail(S.daily.find((c) => c.id === id), 'daily');
});

function updateBadge() {
  const n = (S.state?.stats.likes || 0) + (S.state?.stats.supers || 0);
  const badge = $('#likes-badge');
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : n;
}

// ---------------------------------------------------------------- profile

function timeAgo(iso) {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 31) return `${Math.floor(d)} days ago`;
  return new Date(iso).toLocaleDateString();
}

function renderProfile() {
  const st = S.state;
  if (!st) return;
  const swipes = st.stats.likes + st.stats.supers + st.stats.later + st.stats.nopes;
  $('#avatar-ring').style.setProperty('--p', Math.min(100, (st.history ? 50 : 0) + Math.min(50, swipes * 2.5)));
  $('#profile-sub').textContent = st.history
    ? `Built from ${st.history.entries.toLocaleString()} Netflix views and ${swipes} swipes`
    : `Built from ${swipes} swipes. Add your Netflix history for better picks.`;

  $('#stats').innerHTML = [
    [st.stats.likes, 'Liked'], [st.stats.supers, 'Must watch'], [st.stats.later, 'Later'], [st.stats.nopes, 'Nope'],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');

  const g = st.taste.genres;
  const max = g[0]?.weight || 1;
  $('#taste').innerHTML = g.length
    ? g.map((x) => `<div class="bar-row"><span>${esc(x.name)}</span><div class="bar"><span style="width:${Math.round((x.weight / max) * 100)}%"></span></div></div>`).join('')
      + (st.taste.keywords.length ? `<div class="tags">${st.taste.keywords.map((k) => `<span class="chip">${esc(k.name)}</span>`).join('')}</div>` : '')
    : '<p class="muted">Swipe a few titles, or add your Netflix history, and your taste shows up here.</p>';

  const h = st.history;
  $('#history').innerHTML = h
    ? `<p class="muted">Added ${timeAgo(h.importedAt)} · ${h.entries.toLocaleString()} views · ${h.titles} titles · ${h.matched} found in the catalog</p>
       ${h.recent.map((r) => `<div class="hist-row"><span class="${r.matched ? '' : 'unmatched'}">${esc(r.name)}</span><small>${r.kind === 'series' ? `${r.views} ep · ` : ''}${r.lastWatched || ''}</small></div>`).join('')}`
    : '<p class="muted">No history yet. Add it and Swipeflix stops suggesting what you have already watched.</p>';
  $('#profile-upload').textContent = h ? 'Replace my viewing history (CSV)' : 'Upload viewing history (CSV)';

  const country = REGIONS[st.settings.region] || st.settings.region;
  $('#catalog-info').textContent = st.catalog.source === 'tmdb'
    ? `Netflix ${country}: ${st.catalog.count} titles, updated ${timeAgo(new Date(st.catalog.builtAt).toISOString())}.`
    : `Showing a sample of ${st.catalog.count} Netflix originals. The full catalog for ${country} isn't available yet.`;
  $('#storage-note').textContent = device.isPersistent()
    ? 'Your history and swipes are saved on this device only. We keep none of it on our servers.'
    : "This browser isn't saving data (private window?). Your swipes will be lost when you close it.";
}

$('#open-about').addEventListener('click', () => openSheet('#sheet-about'));

// ---------------------------------------------------------------- move data between devices

$('#open-transfer').addEventListener('click', () => {
  $('#transfer-code').hidden = true;
  $('#transfer-input').value = '';
  openSheet('#sheet-transfer');
});
$('#transfer-send').addEventListener('click', async () => {
  try {
    const { code } = await api.post('/api/transfer', { payload: device.exportJson() });
    const el = $('#transfer-code');
    el.textContent = code;
    el.hidden = false;
  } catch (err) {
    toast(err.message);
  }
});
$('#transfer-claim').addEventListener('click', async () => {
  const code = $('#transfer-input').value.trim();
  if (!code) return toast('Enter the code from your other device');
  if (!confirm("Replace this device's history and swipes with the data from the code?")) return;
  try {
    const { payload } = await api.post('/api/transfer/claim', { code });
    device.replaceAll(JSON.parse(payload));
    closeSheets();
    S.swipedThisSession.clear();
    await loadCatalog();
    await refreshState();
    refill(true);
    toast('Your data is here');
  } catch (err) {
    toast(err.message);
  }
});
$('#reset-swipes').addEventListener('click', resetSwipes);
$('#reset-all').addEventListener('click', resetAll);

// ---------------------------------------------------------------- adding your history (CSV)

const HOWTO_STEPS = 4;
let howtoStep = 1;

function showHowtoStep(n) {
  howtoStep = Math.max(1, Math.min(HOWTO_STEPS, n));
  $$('.howto-step').forEach((el) => (el.hidden = Number(el.dataset.step) !== howtoStep));
  $$('#howto-dots i').forEach((d, i) => d.classList.toggle('on', i === howtoStep - 1));
  $('#howto-back').style.visibility = howtoStep === 1 ? 'hidden' : '';
  $('#howto-next').style.visibility = howtoStep === HOWTO_STEPS ? 'hidden' : '';
}

/** A short walkthrough of getting the file out of Netflix, shown on the first visit and whenever someone adds history. */
function openHowto() {
  showHowtoStep(1);
  openSheet('#sheet-howto');
}

$('#howto-next').addEventListener('click', () => showHowtoStep(howtoStep + 1));
$('#howto-back').addEventListener('click', () => showHowtoStep(howtoStep - 1));
$('#welcome-add').addEventListener('click', openHowto);
$('#profile-upload').addEventListener('click', openHowto);

/** Reads the Netflix viewing list (CSV text) here on the phone and keeps it on this device. */
async function importHistory(csv) {
  const entries = parseViewingHistoryCsv(csv);
  if (!entries.length) throw new Error("That file doesn't look like a Netflix viewing history CSV.");
  const groups = groupHistory(entries).slice(0, 3000);
  const d = device.data();
  d.history = { source: 'csv', importedAt: new Date().toISOString(), entries: entries.length, groups };
  d.onboarded = true;
  device.save();
  hideWelcome();
  await loadCatalog(); // the worldwide titles help recognise more of what was watched
  await refreshState();
  refill(true);
  return { entries: entries.length, groups };
}

async function uploadCsv(file) {
  if (!file) return;
  try {
    const res = await importHistory(await file.text());
    closeSheets();
    toast(`Added ${res.entries.toLocaleString()} views across ${res.groups.length} titles`);
  } catch (err) {
    toast(err.message);
  }
}

$('#csv-input').addEventListener('change', (e) => {
  uploadCsv(e.target.files[0]);
  e.target.value = '';
});
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('#drop-hint').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('#drop-hint').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  uploadCsv(e.dataTransfer.files[0]);
});

// ---------------------------------------------------------------- welcome

function showWelcome() {
  $('#welcome').hidden = false;
}

function hideWelcome() {
  $('#welcome').hidden = true;
}

$('#welcome-skip').addEventListener('click', () => {
  device.data().onboarded = true;
  device.save();
  hideWelcome();
});

// ---------------------------------------------------------------- state

async function refreshState() {
  const d = device.data();
  const p = engine.profile(S.catalog, d);
  S.state = { settings: { ...d.settings }, onboarded: d.onboarded, catalog: p.catalog, history: p.history, stats: p.stats, taste: p.taste };
  updateBadge();
  renderFilters();
  renderProfile();
  return S.state;
}

// ---------------------------------------------------------------- tabs, toast, keys

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === 'daily') loadDaily();
  if (name === 'likes') loadLikes();
  if (name === 'profile') refreshState();
}

$('#tabbar').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) showTab(t.dataset.tab);
});

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function hideCoach() {
  $('#coach').hidden = true;
  try { localStorage.setItem('swipeflix.coach', '1'); } catch {}
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (!a) return;
  if (a === 'like' || a === 'nope') swipeTop(a);
  else if (a === 'rewind') rewind();
  else if (a === 'lucky') feelingLucky();
  else if (a === 'filters') showTab('profile');
});
$('#btn-daily').addEventListener('click', () => showTab('daily'));
$('#daily-back').addEventListener('click', () => showTab('discover'));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { closeSheets(); closePick(); return; }
  const anySheet = $$('.sheet').some((s) => !s.hidden);
  if (!$('#view-discover') || $('#view-discover').hidden || !$('#welcome').hidden || !$('#match').hidden || anySheet) return;
  const keyMap = { ArrowLeft: 'nope', ArrowRight: 'like', ArrowUp: 'super', Enter: 'super', ArrowDown: 'later' };
  if (keyMap[e.key]) {
    e.preventDefault();
    swipeTop(keyMap[e.key]);
  } else if (e.key === ' ') {
    e.preventDefault();
    const el = topCard();
    if (el) stepPage(el, Number(el.dataset.page) >= 1 ? -1 : 1);
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    rewind();
  } else if (e.key === 'l' || e.key === 'L') {
    feelingLucky();
  }
});

// ---------------------------------------------------------------- boot

async function init() {
  const d = device.data();
  if (!d.settings.region) {
    const guess = (navigator.language || '').split('-')[1]?.toUpperCase();
    d.settings.region = guess && REGIONS[guess] ? guess : 'US';
    device.save();
  }
  try { navigator.storage?.persist?.(); } catch {} // ask the browser not to clear our data when space is low
  await loadCatalog();
  const st = await refreshState();
  if (!st.onboarded) showWelcome();
  if (!device.isPersistent()) toast("This browser isn't saving data, so your swipes won't be kept.");
  await refill(true);
  let seenCoach = false;
  try { seenCoach = Boolean(localStorage.getItem('swipeflix.coach')); } catch {}
  if (!seenCoach) {
    $('#coach').hidden = false;
    setTimeout(hideCoach, 9000);
  }
}

init();

// ---------------------------------------------------------------- install as an app (PWA)

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Home-screen shortcuts from manifest.webmanifest: /?tab=daily and /?lucky=1
{
  const q = new URLSearchParams(location.search);
  if (q.get('tab') === 'daily') showTab('daily');
  if (q.get('lucky')) setTimeout(() => feelingLucky(), 600);
}
