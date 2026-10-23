// The "Sync Netflix" bookmark. It is a normal browser bookmark (no extension, no
// Developer mode): when clicked on netflix.com/viewingactivity it reads your own
// viewing activity from the page you are looking at and hands it to SwipeFlick.
// swipeflickBookmarklet is stringified into a javascript: URL, so it must be
// self-contained (no outside references, no // comments).

async function swipeflickBookmarklet(appOrigin) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (!/(^|\.)netflix\.com$/.test(location.hostname)) {
    alert('This bookmark works on Netflix. Open netflix.com/viewingactivity, then click it again.');
    return;
  }
  if (!/viewingactivity/i.test(location.pathname)) {
    if (confirm('Open your Netflix viewing activity now? Click this bookmark again once the page has loaded.')) location.href = 'https://www.netflix.com/viewingactivity';
    return;
  }

  const win = window.open(appOrigin + '/', 'swipeflick');
  if (!win) {
    alert('Your browser blocked the SwipeFlick window. Allow pop-ups for Netflix, then click the bookmark again.');
    return;
  }

  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px 16px;background:#171a21;color:#fff;font:600 15px system-ui,sans-serif;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.5)';
  document.body.appendChild(banner);
  const say = (msg) => { banner.textContent = 'SwipeFlick: ' + msg; };

  const rowEls = () => [...document.querySelectorAll('li.retableRow')];
  const waitFor = async (fn, timeout) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  };
  const moreButton = () => {
    const rows = rowEls();
    const last = rows[rows.length - 1];
    if (!last) return null;
    return [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && !b.disabled && last.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING && !b.closest('li.retableRow'));
  };

  say('reading your viewing activity…');
  let payload = null;
  if (await waitFor(() => rowEls().length, 20000)) {
    const a = document.querySelector('a.viewing-activity-footer-download, .viewing-activity-footer-download a, a[href*="download"][href*="iewing"]');
    if (a && a.href) {
      try {
        const res = await fetch(a.href, { credentials: 'include' });
        const text = res.ok ? await res.text() : '';
        if (/^﻿?"?title"?\s*,\s*"?date"?/i.test(text.trim())) payload = { csv: text };
      } catch (e) {}
    }
    if (!payload) {
      for (let i = 0; i < 600; i++) {
        const btn = moreButton();
        if (!btn) break;
        const before = rowEls().length;
        btn.click();
        say('reading your viewing activity… ' + before + ' titles so far');
        if (!(await waitFor(() => rowEls().length > before, 6000))) break;
      }
      const rows = rowEls().map((li) => ({
        date: (li.querySelector('.date') || {}).textContent ? li.querySelector('.date').textContent.trim() : '',
        title: ((li.querySelector('.title a') || li.querySelector('.title')) || {}).textContent ? (li.querySelector('.title a') || li.querySelector('.title')).textContent.trim() : '',
      })).filter((r) => r.title);
      if (rows.length) payload = { rows };
    }
  }
  if (!payload) {
    say("couldn't find any viewing activity on this page. Check you're on the right profile.");
    setTimeout(() => banner.remove(), 8000);
    return;
  }

  say('sending to SwipeFlick…');
  let ack = null;
  window.addEventListener('message', (e) => {
    if (e.origin === appOrigin && e.data && e.data.source === 'swipeflick-app' && e.data.type === 'history-ack') ack = e.data;
  });
  const message = Object.assign({ source: 'swipeflick-bookmarklet', type: 'history', nonce: String(Date.now()) }, payload);
  for (let i = 0; i < 120 && !ack && !win.closed; i++) {
    try { win.postMessage(message, appOrigin); } catch (e) {}
    await sleep(500);
  }
  say(ack && ack.ok ? 'done ✓ switch to the SwipeFlick tab.' : "couldn't reach SwipeFlick. Keep its tab open and try again.");
  setTimeout(() => banner.remove(), 6000);
}

/** The javascript: URL to put on the draggable bookmark button. */
export function bookmarkletHref(appOrigin) {
  return 'javascript:' + encodeURIComponent(`(${swipeflickBookmarklet.toString()})(${JSON.stringify(appOrigin)});void 0`);
}
