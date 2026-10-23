// Injected into netflix.com/viewingactivity when you press Sync. Reads your
// viewing activity the way you would: it expands the list and reads the rows
// (or takes Netflix's own "Download all" CSV when the page offers it).
// Defines window.swipeflickScrape(); returns {csv} or {rows: [{title, date}]}.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => el.offsetParent !== null && !el.disabled;
  const rowEls = () => [...document.querySelectorAll('li.retableRow')];

  async function waitFor(fn, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  }

  /** The "show more" button is whatever visible button sits after the last row (works in any language). */
  function moreButton() {
    const rows = rowEls();
    const last = rows[rows.length - 1];
    if (!last) return null;
    return [...document.querySelectorAll('button')].find((b) => visible(b) && last.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING && !b.closest('li.retableRow'));
  }

  async function tryDownloadLink() {
    const a = document.querySelector('a.viewing-activity-footer-download, .viewing-activity-footer-download a, a[href*="download"][href*="iewing"]');
    if (!a?.href) return null;
    try {
      const res = await fetch(a.href, { credentials: 'include' });
      const text = res.ok ? await res.text() : '';
      return /^﻿?"?title"?\s*,\s*"?date"?/i.test(text.trim()) ? text : null;
    } catch {
      return null;
    }
  }

  window.swipeflickScrape = async () => {
    if (!(await waitFor(() => rowEls().length, 20000))) return { error: 'empty' };
    const csv = await tryDownloadLink();
    if (csv) return { csv };

    for (let i = 0; i < 600; i++) {
      const btn = moreButton();
      if (!btn) break;
      const before = rowEls().length;
      btn.click();
      if (!(await waitFor(() => rowEls().length > before, 6000))) break;
    }
    const rows = rowEls().map((li) => ({
      date: li.querySelector('.date')?.textContent.trim() || '',
      title: (li.querySelector('.title a') || li.querySelector('.title'))?.textContent.trim() || '',
    })).filter((r) => r.title);
    return rows.length ? { rows } : { error: 'empty' };
  };
})();
