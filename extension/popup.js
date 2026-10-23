const $ = (id) => document.getElementById(id);
const status = (msg, cls = '') => { $('status').textContent = msg; $('status').className = cls; };
const DEFAULT_APP = 'http://localhost:4173';

chrome.storage.local.get('appUrl').then(({ appUrl }) => { $('app').value = appUrl || DEFAULT_APP; });

function waitForTab(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(on); reject(new Error('Netflix took too long to load.')); }, timeout);
    const on = (id, info) => {
      if (id === tabId && info.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(on); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && on(tabId, { status: 'complete' }));
  });
}

async function readNetflix() {
  const tab = await chrome.tabs.create({ url: 'https://www.netflix.com/viewingactivity', active: false });
  try {
    await waitForTab(tab.id);
    const { url } = await chrome.tabs.get(tab.id);
    if (!/netflix\.com\/viewingactivity/i.test(url)) {
      await chrome.tabs.update(tab.id, { active: true });
      throw Object.assign(new Error('Log in to Netflix and choose your profile in the tab that just opened, then press Sync again.'), { keepTab: true });
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['scrape.js'] });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.swipeflickScrape() });
    if (!result || result.error) throw new Error("Couldn't find any viewing activity for this profile. Check that you're on the right Netflix profile.");
    await chrome.tabs.remove(tab.id);
    return result;
  } catch (err) {
    if (!err.keepTab) chrome.tabs.remove(tab.id).catch(() => {});
    throw err;
  }
}

/** Opens SwipeFlick and hands it the history (it acknowledges, we retry until it's ready). */
async function sendToApp(appUrl, payload) {
  const tab = await chrome.tabs.create({ url: appUrl, active: true });
  await waitForTab(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [payload],
    func: (data) => new Promise((resolve) => {
      let tries = 0;
      const onMsg = (e) => {
        if (e.source === window && e.data?.source === 'swipeflick-app' && e.data.type === 'history-ack') {
          clearInterval(timer);
          window.removeEventListener('message', onMsg);
          resolve(e.data);
        }
      };
      window.addEventListener('message', onMsg);
      const timer = setInterval(() => {
        if (++tries > 40) { clearInterval(timer); window.removeEventListener('message', onMsg); resolve({ ok: false, error: 'SwipeFlick did not answer.' }); return; }
        window.postMessage({ source: 'swipeflick-extension', type: 'history', ...data }, location.origin);
      }, 500);
    }),
  });
  if (!result?.ok) throw new Error(result?.error || 'SwipeFlick could not import the history.');
  return result;
}

$('sync').addEventListener('click', async () => {
  let origin;
  try {
    const u = new URL($('app').value.trim() || DEFAULT_APP);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    origin = `${u.protocol}//${u.hostname}/*`;
    $('app').value = u.origin;
  } catch {
    return status('Enter the address of your SwipeFlick (starts with http:// or https://).', 'err');
  }
  $('sync').disabled = true;
  try {
    // Must be asked for straight from the click.
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error('Allow access to SwipeFlick so the extension can hand over your history.');
    await chrome.storage.local.set({ appUrl: $('app').value });
    status('Reading your Netflix viewing activity… this can take a minute.');
    const payload = await readNetflix();
    status('Sending to SwipeFlick…');
    const res = await sendToApp($('app').value, payload);
    status(`Done — ${res.entries?.toLocaleString?.() ?? ''} views imported.`, 'ok');
  } catch (err) {
    status(err.message, 'err');
  } finally {
    $('sync').disabled = false;
  }
});
