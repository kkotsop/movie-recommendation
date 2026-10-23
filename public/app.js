// SwipeFlick client: Tinder's card stack, gestures and screens for movies & series.
import { bookmarkletFor } from './netflix-export.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const api = {
  async req(method, path, body, raw = false) {
    const res = await fetch(path, {
      method,
      headers: body == null ? {} : { 'content-type': raw ? 'text/csv' : 'application/json' },
      body: body == null ? undefined : raw ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.error === 'locked') { showLock(); throw Object.assign(new Error('Locked'), { status: 401 }); }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  },
  get: (p) => api.req('GET', p),
  post: (p, b = {}, raw) => api.req('POST', p, b, raw),
};

const S = {
  state: null,
  queue: [], // cards in the stack, queue[0] is on top
  swipedThisSession: new Set(),
  refilling: false,
  likesFilter: 'all',
  likes: [],
  daily: [],
  polling: null,
  lastJobs: {},
  detailFor: null, // {card, from: 'deck'|'likes'}
  swipeCount: 0,
};

// ---------------------------------------------------------------- formatting

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (id, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}"><use href="#i-${id}"/></svg>`;

const GENRE_EMOJI = {
  action: '💥', adventure: '🧭', 'action & adventure': '💥', animation: '✏️', biography: '📜', comedy: '😂', crime: '🕵️',
  documentary: '🎥', drama: '🎭', family: '🏡', fantasy: '🐉', 'sci-fi & fantasy': '🚀', history: '🏛️', horror: '👻',
  music: '🎵', musical: '🎵', mystery: '🔎', romance: '💘', 'sci-fi': '🚀', 'science fiction': '🚀', sport: '🏀',
  thriller: '🔪', war: '⚔️', 'war & politics': '⚔️', western: '🤠', kids: '🧸', reality: '📺',
};

function hue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function mainGenre(t) {
  const g = (t.genres || []).map((x) => x.toLowerCase());
  return g.find((x) => x !== 'drama' && GENRE_EMOJI[x]) || g[0] || '';
}

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
  return `<div class="card-meta">${ratingHtml(t)}<span>${t.type === 'series' ? 'Series' : 'Movie'}</span>${len ? `<span>·</span><span>${esc(len)}</span>` : ''}</div>`;
}

/** A page background: the real poster/backdrop, or a generated poster. */
function pageHtml(t, kind, extraCls = '') {
  const img = kind === 'backdrop' ? t.backdrop || t.poster : t.poster;
  if (img) return `<div class="card-page ${extraCls}" style="background-image:url('${esc(img)}')"></div>`;
  const g = mainGenre(t);
  return `<div class="card-page poster-gen ${extraCls}" style="--h:${hue(t.title)}">
    <div class="pg-emoji">${GENRE_EMOJI[g] || '🎬'}</div>
    <div class="pg-title">${esc(t.title)}</div>
    <div class="pg-type">${t.type === 'series' ? 'A Netflix series' : 'A Netflix film'}</div>
  </div>`;
}

function chipsHtml(t) {
  const chips = (t.genres || []).slice(0, 3).map((g) => `<span class="chip">${esc(g)}</span>`);
  if (t.watched) chips.unshift('<span class="chip watched">↻ Rewatch</span>');
  return `<div class="chips">${chips.join('')}</div>`;
}

function peopleLine(t) {
  const lines = [];
  if (t.creators?.length) lines.push(`<li>${t.type === 'series' ? 'Created by' : 'Directed by'} <b>${esc(t.creators.join(', '))}</b></li>`);
  if (t.cast?.length) lines.push(`<li>Starring <b>${esc(t.cast.slice(0, 3).join(', '))}</b></li>`);
  return lines.join('');
}

function cardHtml(t) {
  const title = `<h2>${esc(t.title)}<span class="year">${t.year || ''}</span></h2>`;
  return `
    ${pageHtml(t, 'poster', 'on')}
    ${pageHtml(t, 'backdrop', 'page-text')}
    ${pageHtml(t, 'poster', 'page-text')}
    <div class="card-bars"><span class="on"></span><span></span><span></span></div>
    <div class="stamp stamp-like">Like</div>
    <div class="stamp stamp-nope">Nope</div>
    <div class="stamp stamp-super">Must<br>watch</div>
    <div class="card-shade"></div>
    <div class="card-info" data-page="0">
      ${title}${metaHtml(t)}
      <div class="reason ${t.reason?.kind === 'explore' ? 'explore' : ''}">${esc(t.reason?.text || '')}</div>
      ${chipsHtml(t)}
    </div>
    <div class="card-info" data-page="1" hidden>
      ${title}
      <div class="card-overview">${esc(t.overview || 'No description yet.')}</div>
    </div>
    <div class="card-info" data-page="2" hidden>
      ${title}
      <ul class="why-list">
        <li>✨ ${esc(t.reason?.text || 'Picked for you')}</li>
        ${t.imdbVotes ? `<li>⭐ <b>${t.imdbRating}</b> on IMDb from ${Number(t.imdbVotes).toLocaleString()} votes</li>` : ''}
        ${peopleLine(t)}
      </ul>
      <div class="chips">${(t.keywords || []).slice(0, 5).map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div>
    </div>
    <button class="info-btn" aria-label="Open info">${icon('up')}</button>`;
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
  for (const el of $$('.card', deckEl)) {
    if (!visible.some((c) => c.id === el.dataset.id) && !el.classList.contains('fly')) el.remove();
  }
  visible.forEach((c, i) => {
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
  $('[data-action="rewind"]').disabled = !(S.state?.stats.likes + S.state?.stats.supers + S.state?.stats.nopes);
}

function updateEmptyState() {
  const radar = $('#radar');
  const job = S.state?.jobs.catalog;
  const building = job?.state === 'running';
  const empty = !S.queue.length;
  radar.hidden = !empty && !building;
  $('#actions').style.visibility = empty ? 'hidden' : '';
  if (radar.hidden) return;
  radar.classList.toggle('still', false);
  const progress = $('#radar-progress');
  progress.hidden = !building;
  if (building) {
    $('#radar-text').textContent = job.message || 'Building your catalog…';
    progress.firstElementChild.style.width = `${Math.round((job.progress || 0) * 100)}%`;
    radar.style.background = empty ? '' : 'rgba(14,16,20,.82)';
    radar.style.zIndex = '20';
  } else {
    radar.style.background = '';
    $('#radar-text').textContent = S.refilling ? 'Finding titles for you…' : "You've seen everything that matches your settings. Try loosening your filters — or let luck decide.";
  }
  $('#radar-actions').hidden = S.refilling || building;
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
    const exclude = [...S.queue.map((c) => c.id), ...S.swipedThisSession].join(',');
    const { cards } = await api.get(`/api/deck?n=10&exclude=${encodeURIComponent(exclude)}`);
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
  const rot = (dx / w) * 22 * (grabTop ? 1 : -1);
  el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
  const like = clamp(dx / (w * 0.25));
  const nope = clamp(-dx / (w * 0.25));
  const sup = Math.abs(dy) > Math.abs(dx) ? clamp(-dy / (h * 0.18)) : 0;
  $('.stamp-like', el).style.opacity = sup ? 0 : like;
  $('.stamp-nope', el).style.opacity = sup ? 0 : nope;
  $('.stamp-super', el).style.opacity = sup;
  $('.act-like').classList.toggle('lit', !sup && like > 0.6);
  $('.act-nope').classList.toggle('lit', !sup && nope > 0.6);
  $('.act-super').classList.toggle('lit', sup > 0.6);
  const next = S.queue[1] && cardEl(S.queue[1].id);
  if (next) {
    next.style.transition = 'none';
    next.style.transform = `scale(${0.95 + 0.05 * clamp(Math.hypot(dx, dy) / (w * 0.5))})`;
  }
}

function clearLit() {
  $$('.act').forEach((b) => b.classList.remove('lit'));
}

function bindDrag(el) {
  let active = false;
  let sx, sy, dx, dy, t0, lastX, lastY, lastT, vx, vy, grabTop;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || el !== topCard() || e.target.closest('.info-btn')) return;
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
    let action = null;
    if (-dy > h * 0.22 && Math.abs(dy) > Math.abs(dx)) action = 'super';
    else if (dx > w * 0.35 || (vx > 0.6 && dx > 30)) action = 'like';
    else if (dx < -w * 0.35 || (vx < -0.6 && dx < -30)) action = 'nope';
    if (action) flyOut(el, action, { dx, dy, vx, vy });
    else resetDrag(el, true);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  $('.info-btn', el).addEventListener('click', (e) => {
    e.stopPropagation();
    openDetail(S.queue.find((c) => c.id === el.dataset.id), 'deck');
  });
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
  if (e.clientY > r.bottom - r.height * 0.28) return openDetail(S.queue.find((c) => c.id === el.dataset.id), 'deck');
  stepPage(el, e.clientX < r.left + r.width / 2 ? -1 : 1);
}

/** Tinder's tap-through photos: poster → synopsis → why it's here. */
function stepPage(el, dir) {
  const pages = $$('.card-page', el);
  const cur = Number(el.dataset.page);
  const next = cur + dir;
  if (next < 0 || next >= pages.length) {
    el.animate([{ transform: 'none' }, { transform: `perspective(800px) rotateY(${dir * 5}deg)` }, { transform: 'none' }], { duration: 220 });
    return;
  }
  el.dataset.page = String(next);
  pages.forEach((p, i) => p.classList.toggle('on', i === next));
  $$('.card-bars span', el).forEach((b, i) => b.classList.toggle('on', i === next));
  $$('.card-info', el).forEach((info) => (info.hidden = Number(info.dataset.page) !== next));
}

function flyOut(el, action, { dx = 0, dy = 0, vy = 0 } = {}) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const W = window.innerWidth;
  let x, y, rot;
  if (action === 'super') {
    x = dx;
    y = -(window.innerHeight + h);
    rot = (dx / w) * 15;
  } else {
    const dir = action === 'like' ? 1 : -1;
    x = dir * (W / 2 + w * 1.2);
    y = dy + vy * 150;
    rot = dir * 30;
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
  btn.classList.add('pressed', 'lit');
  setTimeout(() => btn.classList.remove('pressed', 'lit'), 220);
  paintDrag(el, action === 'like' ? 40 : action === 'nope' ? -40 : 0, action === 'super' ? -40 : 0, true);
  requestAnimationFrame(() => flyOut(el, action));
}

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
  layoutDeck();
  if (action === 'super') toast(`⭐ ${card.title} added to Must watch`);
  try {
    const { stats } = await api.post('/api/swipe', { id: card.id, action });
    S.state.stats = stats;
    updateBadge();
    layoutDeck();
  } catch (err) {
    toast(err.message);
  }
  if (S.queue.length < 5) refill();
}

async function rewind() {
  try {
    const { card, action } = await api.post('/api/rewind');
    if (!card) return;
    S.swipedThisSession.delete(card.id);
    S.queue = [card, ...S.queue.filter((c) => c.id !== card.id)];
    cardEl(card.id)?.remove();
    layoutDeck();
    const el = cardEl(card.id);
    const from = action === 'like' ? 'translate(120%, 0) rotate(25deg)' : action === 'nope' ? 'translate(-120%, 0) rotate(-25deg)' : 'translate(0, -120%)';
    el.style.transform = from;
    el.getBoundingClientRect();
    el.classList.add('spring');
    el.style.transform = '';
    const btn = $('.act-rewind');
    btn.classList.add('lit');
    setTimeout(() => btn.classList.remove('lit'), 300);
    refreshState();
  } catch (err) {
    toast(err.status === 404 ? 'Nothing to rewind' : err.message);
  }
}

// ---------------------------------------------------------------- feeling lucky ("It's a Match!")

async function feelingLucky(exclude = []) {
  hideCoach();
  const btn = $('.act-lucky');
  btn.classList.add('lit', 'pressed');
  setTimeout(() => btn.classList.remove('lit', 'pressed'), 250);
  try {
    const { card } = await api.get(`/api/lucky?exclude=${encodeURIComponent(exclude.join(','))}`);
    showPick(card, exclude);
  } catch (err) {
    toast(err.message);
  }
}

function showPick(t, tried) {
  const box = $('#match-inner');
  box.innerHTML = `
    <h2 class="match-title">It's a Pick!</h2>
    <p class="match-sub">Highly rated and made for your taste</p>
    <div class="match-poster">${pageHtml(t, 'poster')}</div>
    <div class="match-name">${esc(t.title)} <span class="muted">${t.year || ''}</span></div>
    <div class="match-meta">${ratingHtml(t)}<span>${t.type === 'series' ? 'Series' : 'Movie'}</span>${lengthText(t) ? `<span>${esc(lengthText(t))}</span>` : ''}</div>
    <div class="match-reason">${esc(t.reason?.text || '')}</div>
    <div class="match-btns">
      <a class="pill netflix" href="${esc(t.netflixUrl)}" target="_blank" rel="noopener">${icon('play')}&nbsp;Watch on Netflix</a>
      <button class="pill pill-brand" data-pick="save">Save to Must watch</button>
      <button class="pill pill-outline" data-pick="again">Another pick</button>
      <button class="link" data-pick="close">Keep swiping</button>
    </div>`;
  $('#match').hidden = false;
  box.onclick = async (e) => {
    const what = e.target.closest('[data-pick]')?.dataset.pick;
    if (!what) return;
    if (what === 'close') return closePick();
    if (what === 'again') return feelingLucky([...tried, t.id]);
    if (what === 'save') {
      await api.post('/api/swipe', { id: t.id, action: 'super' });
      S.swipedThisSession.add(t.id);
      S.queue = S.queue.filter((c) => c.id !== t.id);
      cardEl(t.id)?.remove();
      layoutDeck();
      refreshState();
      toast(`⭐ ${t.title} added to Must watch`);
      closePick();
    }
  };
}

function closePick() {
  $('#match').hidden = true;
}

// ---------------------------------------------------------------- detail sheet (expanded card)

function openDetail(t, from) {
  if (!t) return;
  S.detailFor = { card: t, from };
  const actions = from === 'deck' || from === 'daily'
    ? `<button class="act act-lg act-nope" data-d="nope" aria-label="Nope">${icon('nope')}</button>
       <button class="act act-sm act-super" data-d="super" aria-label="Must watch">${icon('star')}</button>
       <button class="act act-lg act-like" data-d="like" aria-label="Like">${icon('heart')}</button>`
    : `<button class="act act-lg act-nope" data-d="remove" aria-label="Remove from likes" title="Remove from likes">${icon('nope')}</button>`;
  $('#detail').innerHTML = `
    <div class="detail-hero">${pageHtml(t, 'poster')}
      <button class="detail-close" data-close aria-label="Close">${icon('down')}</button>
    </div>
    <div class="detail-content">
      <h1>${esc(t.title)}<span class="year">${t.year || ''}</span></h1>
      ${metaHtml(t)}
      ${t.reason?.text ? `<div class="reason ${t.reason.kind === 'explore' ? 'explore' : ''}">${esc(t.reason.text)}</div>` : ''}
      ${chipsHtml(t)}
      <a class="netflix-btn" href="${esc(t.netflixUrl)}" target="_blank" rel="noopener">${icon('play')} Watch on Netflix</a>
      <div class="detail-section"><h2>About</h2><p>${t.tagline ? `<i>${esc(t.tagline)}</i><br>` : ''}${esc(t.overview || 'No description yet.')}</p></div>
      ${t.creators?.length || t.cast?.length ? `<div class="detail-section"><ul class="why-list">${peopleLine(t)}</ul></div>` : ''}
      ${t.keywords?.length ? `<div class="detail-section"><h2>Vibes</h2><div class="tags">${t.keywords.slice(0, 10).map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div></div>` : ''}
      ${t.imdbVotes ? `<div class="detail-section"><p>⭐ <b>${t.imdbRating}</b>/10 on IMDb from ${Number(t.imdbVotes).toLocaleString()} votes${t.imdbId ? ` · <a href="https://www.imdb.com/title/${esc(t.imdbId)}/" target="_blank" rel="noopener">IMDb page</a>` : ''}</p></div>` : ''}
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
    await api.post('/api/unswipe', { id: card.id });
    S.swipedThisSession.delete(card.id);
    toast(`Removed ${card.title}`);
    await refreshState();
    loadLikes();
  } else if (from === 'daily') {
    await api.post('/api/swipe', { id: card.id, action: d });
    S.swipedThisSession.add(card.id);
    S.queue = S.queue.filter((c) => c.id !== card.id);
    cardEl(card.id)?.remove();
    layoutDeck();
    S.daily = S.daily.filter((c) => c.id !== card.id);
    renderDaily();
    toast(d === 'nope' ? `Won't show ${card.title} again` : `${d === 'super' ? '⭐' : '💚'} ${card.title} saved`);
    refreshState();
  } else if (topCard()?.dataset.id === card.id) {
    setTimeout(() => swipeTop(d), 150);
  }
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

// ---------------------------------------------------------------- discovery settings

const REGIONS = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia', IE: 'Ireland', NZ: 'New Zealand', GR: 'Greece', CY: 'Cyprus',
  DE: 'Germany', AT: 'Austria', CH: 'Switzerland', FR: 'France', BE: 'Belgium', NL: 'Netherlands', ES: 'Spain', PT: 'Portugal', IT: 'Italy',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland', CZ: 'Czechia', HU: 'Hungary', RO: 'Romania', TR: 'Türkiye',
  IL: 'Israel', IN: 'India', JP: 'Japan', KR: 'South Korea', SG: 'Singapore', PH: 'Philippines', BR: 'Brazil', MX: 'Mexico', AR: 'Argentina',
  CO: 'Colombia', CL: 'Chile', ZA: 'South Africa',
};
$('#region').innerHTML = Object.entries(REGIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

function renderFilters() {
  const s = S.state.settings;
  $$('#types button').forEach((b) => b.classList.toggle('on', b.dataset.types === s.types));
  $('#include-watched').checked = s.includeWatched;
  $('#min-rating').value = s.minRating;
  $('#min-rating-val').textContent = s.minRating ? `${s.minRating}+` : 'Any';
  $('#region').value = s.region;
  $('#region-note').textContent = S.state.catalog.source === 'tmdb'
    ? 'Only titles streaming on Netflix in this country are shown.'
    : 'Add a TMDB key in Profile to use the real Netflix catalog for this country. Using the built-in sample for now.';
}

async function saveSettings(patch, reloadDeck = true) {
  try {
    S.state = await api.post('/api/settings', patch);
    renderFilters();
    renderProfile();
    if (reloadDeck) refill(true);
    startPolling();
  } catch (err) {
    toast(err.message);
  }
}

$('#types').addEventListener('click', (e) => {
  const b = e.target.closest('[data-types]');
  if (b) saveSettings({ types: b.dataset.types });
});
$('#include-watched').addEventListener('change', (e) => saveSettings({ includeWatched: e.target.checked }));
$('#min-rating').addEventListener('input', (e) => ($('#min-rating-val').textContent = Number(e.target.value) ? `${e.target.value}+` : 'Any'));
$('#min-rating').addEventListener('change', (e) => saveSettings({ minRating: Number(e.target.value) }));
$('#region').addEventListener('change', (e) => saveSettings({ region: e.target.value }));

// ---------------------------------------------------------------- reset

async function resetSwipes() {
  if (!confirm('Reset all your swipes? Liked, Must watch and Nope lists are cleared. Your Netflix history stays.')) return;
  S.state = await api.post('/api/reset', { scope: 'swipes' });
  S.swipedThisSession.clear();
  closeSheets();
  updateBadge();
  renderProfile();
  toast('Fresh start — swipes reset');
  refill(true);
}

async function resetAll() {
  if (!confirm('Reset everything? This clears your swipes and imported Netflix history, and logs this app out of Netflix.')) return;
  S.state = await api.post('/api/reset', { scope: 'all' });
  S.swipedThisSession.clear();
  updateBadge();
  showWelcome();
  refill(true);
}

// ---------------------------------------------------------------- likes

async function loadLikes() {
  try {
    S.likes = (await api.get('/api/likes')).likes;
  } catch (err) {
    toast(err.message);
  }
  renderLikes();
}

function renderLikes() {
  const list = S.likes.filter((l) => S.likesFilter === 'all' || l.action === 'super');
  $('#likes-grid').innerHTML = list.length
    ? list.map((t) => `
      <button class="like-card" data-id="${esc(t.id)}">
        ${pageHtml(t, 'poster')}
        ${t.action === 'super' ? `<span class="lc-star">${icon('star')}</span>` : ''}
        <span class="lc-info"><div class="lc-title">${esc(t.title)}</div><div class="lc-sub">${t.year || ''} · ${t.type === 'series' ? 'Series' : 'Movie'}${t.imdbRating ? ` · ★ ${t.imdbRating}` : ''}</div></span>
      </button>`).join('')
    : `<div class="empty-note"><span class="big">${S.likesFilter === 'super' ? '⭐' : '💚'}</span>${S.likesFilter === 'super' ? 'Swipe up or tap the star to add titles to Must watch.' : 'Titles you swipe right on show up here.'}</div>`;
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

async function loadDaily() {
  try {
    const { cards, date } = await api.get('/api/daily');
    S.daily = cards;
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
        ${pageHtml(t, 'poster')}
        <span class="lc-info"><div class="lc-title">${esc(t.title)}</div><div class="lc-sub">${t.year || ''} · ${t.type === 'series' ? 'Series' : 'Movie'}${t.imdbRating ? ` · ★ ${t.imdbRating}` : ''}</div><span class="lc-why">${esc(t.reason?.text || '')}</span></span>
      </button>`).join('')
    : '<div class="empty-note"><span class="big">🌤️</span>You\'re all caught up. Fresh picks arrive tomorrow.</div>';
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
  const swipes = st.stats.likes + st.stats.supers + st.stats.nopes;
  const strength = Math.min(100, (st.history ? 50 : 0) + Math.min(50, swipes * 2.5));
  $('#avatar-ring').style.setProperty('--p', strength);
  $('#profile-sub').textContent = st.history
    ? `Built from ${st.history.entries.toLocaleString()} Netflix views and ${swipes} swipes`
    : `Built from ${swipes} swipes — import your Netflix history for better picks`;

  $('#stats').innerHTML = [
    [st.stats.likes, 'Likes'], [st.stats.supers, 'Must watch'], [st.stats.nopes, 'Nopes'],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');

  const g = st.taste.genres;
  const max = g[0]?.weight || 1;
  $('#taste').innerHTML = g.length
    ? g.map((x) => `<div class="bar-row"><span>${esc(x.name)}</span><div class="bar"><span style="width:${Math.round((x.weight / max) * 100)}%"></span></div></div>`).join('')
      + (st.taste.keywords.length ? `<div class="tags">${st.taste.keywords.map((k) => `<span class="chip">${esc(k.name)}</span>`).join('')}</div>` : '')
    : '<p class="muted">Swipe a few cards (or import your Netflix history) and your taste shows up here.</p>';

  const h = st.history;
  $('#history').innerHTML = h
    ? `<p class="muted">${h.source === 'netflix' ? 'Synced from Netflix' : 'Imported from CSV'} ${timeAgo(h.importedAt)} · ${h.entries.toLocaleString()} views · ${h.titles} titles · ${h.matched} matched to the catalog</p>
       ${h.recent.map((r) => `<div class="hist-row"><span class="${r.matched ? '' : 'unmatched'}">${esc(r.name)}</span><small>${r.kind === 'series' ? `${r.views} ep · ` : ''}${r.lastWatched || ''}</small></div>`).join('')}`
    : '<p class="muted">No history yet. Tap <b>Sync Netflix</b> to log in, or upload the CSV from netflix.com → Account → Viewing activity → Download all.</p>';

  $('#catalog-info').textContent = st.catalog.source === 'tmdb'
    ? `Netflix ${REGIONS[st.settings.region] || st.settings.region} via TMDB: ${st.catalog.count} titles, updated ${timeAgo(new Date(st.catalog.builtAt).toISOString())}.`
    : `Built-in sample: ${st.catalog.count} Netflix originals with IMDb ratings. Add a free TMDB API key to swipe everything on Netflix in your country, with posters.`;
  $('#tmdb-key').placeholder = st.settings.hasTmdbKey ? '•••••••• (saved — paste a new one to replace)' : 'Paste your TMDB API key or read access token';
  renderJobs();
}

function statusHtml(job) {
  if (!job || job.state === 'idle') return null;
  const running = !['done', 'error'].includes(job.state);
  return { cls: running ? '' : job.state, html: `${running ? '<span class="spinner"></span>' : job.state === 'done' ? '✅' : '⚠️'}<span>${esc(job.message || '')}</span>` };
}

function renderJobs() {
  const nf = statusHtml(S.state.jobs.netflix);
  for (const id of ['#welcome-status', '#profile-status']) {
    const el = $(id);
    el.hidden = !nf;
    if (nf) {
      el.className = `sync-status ${nf.cls}`;
      el.innerHTML = nf.html;
    }
  }
  const cat = statusHtml(S.state.jobs.catalog);
  const el = $('#catalog-status');
  el.hidden = !cat;
  if (cat) {
    el.className = `sync-status ${cat.cls}`;
    el.innerHTML = cat.html;
  }
}

$('#tmdb-save').addEventListener('click', () => {
  const key = $('#tmdb-key').value.trim();
  if (!key) return toast('Paste a TMDB key first');
  $('#tmdb-key').value = '';
  saveSettings({ tmdbKey: key }, false);
  toast('Key saved — building your Netflix catalog…');
});
$('#catalog-refresh').addEventListener('click', async () => {
  if (!S.state.settings.hasTmdbKey) return toast('Add a TMDB key first');
  await api.post('/api/catalog/refresh');
  startPolling();
});
$('#reset-swipes').addEventListener('click', resetSwipes);
$('#reset-all').addEventListener('click', resetAll);

// ---------------------------------------------------------------- history import

async function connectNetflix() {
  if (S.state && !S.state.features?.browserLogin) return openSyncSheet();
  try {
    await api.post('/api/netflix/connect');
    startPolling();
  } catch (err) {
    toast(err.message);
  }
}

async function uploadCsv(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const res = await api.post('/api/history/csv', text, true);
    toast(`Imported ${res.entries.toLocaleString()} views across ${res.titles} titles`);
    hideWelcome();
    await refreshState();
    refill(true);
    startPolling();
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

// ---------------------------------------------------------------- phone sync (bookmark)

function openSyncSheet() {
  const code = bookmarkletFor(location.origin);
  $('#sync-code').value = code;
  $('#sync-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Bookmark copied. Paste it as the address of a new bookmark.');
    } catch {
      $('#sync-code').select();
      toast('Select the text below and copy it');
    }
  };
  openSheet('#sheet-sync');
}

/** The bookmark hands the viewing list back as #import=<base64 csv>. */
async function importFromHash() {
  const m = location.hash.match(/^#import=(.+)$/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const csv = decodeURIComponent(escape(atob(m[1])));
    const res = await api.post('/api/history/csv', csv, true);
    toast(`Imported ${res.entries.toLocaleString()} views across ${res.titles} titles`);
    hideWelcome();
    await refreshState();
    refill(true);
    startPolling();
  } catch (err) {
    if (err.status !== 401) toast(err.message || 'Could not read that import');
  }
  return true;
}

// ---------------------------------------------------------------- lock (hosted mode)

let afterUnlock = null;
function showLock() {
  $('#lock').hidden = false;
  $('#lock-code').focus();
}

$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#lock-error');
  err.hidden = true;
  try {
    await api.post('/api/login', { code: $('#lock-code').value });
    $('#lock').hidden = true;
    $('#lock-code').value = '';
    if (afterUnlock) { const go = afterUnlock; afterUnlock = null; go(); }
    else location.reload();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  }
});

// ---------------------------------------------------------------- welcome

function showWelcome() {
  $('#welcome').hidden = false;
}

function hideWelcome() {
  $('#welcome').hidden = true;
}

$('#welcome-netflix').addEventListener('click', connectNetflix);
$('#profile-sync').addEventListener('click', connectNetflix);
$('#welcome-skip').addEventListener('click', async () => {
  await api.post('/api/onboarded');
  hideWelcome();
});

// ---------------------------------------------------------------- state & polling

async function refreshState() {
  S.state = await api.get('/api/state');
  updateBadge();
  renderFilters();
  renderProfile();
  return S.state;
}

function jobRunning(j) {
  return ['running', 'launching', 'waiting-login', 'reading'].includes(j?.state);
}

function startPolling() {
  if (S.polling) return;
  S.polling = setInterval(async () => {
    const before = S.lastJobs;
    const st = await refreshState().catch(() => null);
    if (!st) return;
    S.lastJobs = structuredClone(st.jobs);
    const nfDone = jobRunning(before.netflix) && st.jobs.netflix.state === 'done';
    const catDone = jobRunning(before.catalog) && !jobRunning(st.jobs.catalog);
    if (nfDone) {
      toast(st.jobs.netflix.message);
      hideWelcome();
      refill(true);
    }
    if (catDone) {
      if (st.jobs.catalog.state === 'done') toast(`🍿 ${st.jobs.catalog.message}`);
      refill(true);
    }
    updateEmptyState();
    if (!jobRunning(st.jobs.netflix) && !jobRunning(st.jobs.catalog)) {
      clearInterval(S.polling);
      S.polling = null;
    }
  }, 1000);
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
  try { localStorage.setItem('swipeflick.coach', '1'); } catch {}
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (!a) return;
  if (a === 'like' || a === 'nope' || a === 'super') swipeTop(a);
  else if (a === 'rewind') rewind();
  else if (a === 'lucky') feelingLucky();
  else if (a === 'filters') openSheet('#sheet-filters');
  else if (a === 'reset') resetSwipes();
});
$('#btn-filters').addEventListener('click', () => openSheet('#sheet-filters'));
$('#btn-reset').addEventListener('click', resetSwipes);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { closeSheets(); closePick(); return; }
  const onDeck = !$('#view-discover').hidden && $('#welcome').hidden && $('#match').hidden;
  const detailOpen = !$('#sheet-detail').hidden;
  if (detailOpen && e.key === 'ArrowDown') { e.preventDefault(); closeSheets(); return; }
  if (!onDeck || !$('#sheet-filters').hidden) return;
  const keyMap = { ArrowLeft: 'nope', ArrowRight: 'like', Enter: 'super' };
  if (keyMap[e.key]) {
    e.preventDefault();
    if (detailOpen) closeSheets();
    swipeTop(keyMap[e.key]);
  } else if (detailOpen) {
    return;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    openDetail(S.queue[0], 'deck');
  } else if (e.key === ' ') {
    e.preventDefault();
    const el = topCard();
    if (el) stepPage(el, Number(el.dataset.page) >= 2 ? -2 : 1);
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    rewind();
  } else if (e.key === 'l' || e.key === 'L') {
    feelingLucky();
  }
});

// ---------------------------------------------------------------- boot

async function init() {
  const st = await refreshState();
  S.lastJobs = structuredClone(st.jobs);
  const phoneOnly = !st.features.browserLogin;
  if (phoneOnly) {
    $('#welcome-netflix').textContent = 'Sync from Netflix';
    $('#profile-sync').lastChild.textContent = 'Sync Netflix';
    const help = $('.welcome-help');
    help.querySelector('summary').textContent = 'How does syncing work?';
    help.innerHTML = help.querySelector('summary').outerHTML + '<p>You save a bookmark once. When you tap it on netflix.com, it reads your <b>Viewing activity</b> in your own signed-in browser and brings the list back here. SwipeFlick never sees your password.</p>';
  }
  if (!st.onboarded) {
    showWelcome();
    const guess = (navigator.language || '').split('-')[1]?.toUpperCase();
    if (guess && REGIONS[guess] && guess !== st.settings.region && st.settings.region === 'US') await saveSettings({ region: guess }, false);
  }
  await importFromHash();
  await refill(true);
  let seenCoach = false;
  try { seenCoach = Boolean(localStorage.getItem('swipeflick.coach')); } catch {}
  if (!seenCoach) {
    $('#coach').hidden = false;
    setTimeout(hideCoach, 9000);
  }
  if (jobRunning(st.jobs.netflix) || jobRunning(st.jobs.catalog)) startPolling();
}

(async () => {
  try {
    const auth = await api.get('/api/auth');
    if (auth.required && !auth.authed) { afterUnlock = init; showLock(); return; }
  } catch {}
  init();
})();

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
