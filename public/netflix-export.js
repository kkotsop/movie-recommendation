// The "Sync from Netflix" bookmark. It runs on netflix.com/viewingactivity in your phone's own
// browser, where you are already logged in, so your password never goes anywhere. It reads the
// list (the "Download all" file, or the page itself as a fallback) and opens SwipeFlick with the
// rows in the URL fragment. Fragments are never sent to a server, and opening your app is a plain
// navigation, so Netflix's content-security rules can't block it.
//
// This function is stringified into a javascript: URL, so it must be fully self-contained, use
// semicolons, and avoid // comments and % characters (newlines are flattened when the bookmark is saved).
export async function netflixExport(appUrl) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = location.hostname;
  if (!/(^|\.)netflix\.com$/.test(host)) {
    alert('Open netflix.com in this browser, sign in, then tap this bookmark again.');
    return;
  }
  if (!/viewingactivity/i.test(location.pathname)) {
    alert('Taking you to your viewing activity. When it has loaded, tap this bookmark again.');
    location.href = 'https://www.netflix.com/viewingactivity';
    return;
  }

  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:14px;background:#14d9c4;color:#0e1014;font:700 15px system-ui;text-align:center';
  banner.textContent = 'SwipeFlick: reading your viewing activity…';
  document.body.appendChild(banner);

  let csv = null;
  const link = [...document.querySelectorAll('a')].find((a) => /download all/i.test(a.textContent) && a.href);
  if (link) {
    try {
      const res = await fetch(link.href, { credentials: 'include' });
      const text = await res.text();
      if (res.ok && text.includes('\n') && !/<html/i.test(text.slice(0, 300))) csv = text;
    } catch (e) { /* fall back to reading the page */ }
  }

  if (!csv) {
    for (let i = 0; i < 400; i++) {
      const more = [...document.querySelectorAll('button')].find((b) => /show more/i.test(b.textContent)) || document.querySelector('.viewing-activity-footer button');
      if (!more || more.disabled || more.offsetParent === null) break;
      more.click();
      if ((i & 3) === 0) banner.textContent = `SwipeFlick: reading your viewing activity… (${document.querySelectorAll('li.retableRow').length} so far)`;
      await wait(700);
    }
    const rows = [...document.querySelectorAll('li.retableRow')].map((li) => [
      ((li.querySelector('.date') || {}).textContent || '').trim(),
      ((li.querySelector('.title a') || li.querySelector('.title') || {}).textContent || '').trim(),
    ]).filter((r) => r[1]);
    if (!rows.length) {
      banner.remove();
      alert('SwipeFlick could not find any viewing activity on this page. Make sure the right profile is selected, or Netflix has changed this page.');
      return;
    }
    csv = 'Title,Date\n' + rows.map(([d, t]) => `"${t.replace(/"/g, '""')}","${d}"`).join('\n');
  }

  const lines = csv.split(/\r?\n/); /* newest first; keep it small enough for a URL */
  csv = [lines[0], ...lines.slice(1, 2001)].join('\n');
  banner.textContent = 'SwipeFlick: opening your app…';
  location.href = `${appUrl}/#import=${btoa(unescape(encodeURIComponent(csv)))}`;
}

/** The javascript: URL to save as a bookmark. */
export function bookmarkletFor(appUrl) {
  const code = netflixExport.toString().replace(/\s*\n\s*/g, ' ');
  return `javascript:(${code})(${JSON.stringify(appUrl)});void 0`;
}
