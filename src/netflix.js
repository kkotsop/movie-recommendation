// "Log in with Netflix": Netflix has no public API, so we open a real browser
// window on netflix.com. You sign in and pick your profile there (this app
// never sees your password), then we open your Viewing Activity page and
// take the same CSV the "Download all" link gives you. The browser profile is
// kept in data/browser-profile so the next sync doesn't ask you to log in.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { parseViewingHistoryCsv, entriesFromRows } from './history.js';

const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const SIGNED_IN = /netflix\.com\/([a-z]{2}(-[a-z]{2})?\/)?(browse|title|watch|latest|search|viewingactivity|account|YourAccount)/i;
const PROFILE_GATE = /netflix\.com\/.*(ProfilesGate|profiles\/manage|SwitchProfile)/i;

async function launch() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright is not installed. Run "npm install" (and "npx playwright install chromium" if you have no Chrome/Edge), or upload your viewing history CSV instead.');
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  let lastError;
  // Prefer the Chrome/Edge you already have; fall back to Playwright's Chromium.
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel, viewport: null, acceptDownloads: true });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Could not open a browser window: ${lastError?.message?.split('\n')[0]}`);
}

async function waitForUrl(context, test, what) {
  const deadline = Date.now() + LOGIN_TIMEOUT;
  while (Date.now() < deadline) {
    const pages = context.pages();
    if (!pages.length) throw new Error('The Netflix window was closed before the sync finished.');
    const page = pages.find((p) => test(p.url()));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for you to ${what}.`);
}

async function readViaDownload(page) {
  const link = page.locator('.viewing-activity-footer-download, a:has-text("Download all"), button:has-text("Download all")').first();
  if (!(await link.count())) return null;
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), link.click()]);
  const file = await download.path();
  return parseViewingHistoryCsv(fs.readFileSync(file, 'utf8'));
}

async function readViaPage(page, onStatus) {
  // Fallback: expand the list with "Show more" and read the rows off the page.
  for (let i = 0; i < 400; i++) {
    const more = page.locator('.viewing-activity-footer button, button:has-text("Show More"), button:has-text("Show more")').first();
    if (!(await more.count()) || !(await more.isVisible().catch(() => false))) break;
    await more.click().catch(() => {});
    await page.waitForTimeout(700);
    if (i % 10 === 0) onStatus('reading', `Reading your viewing activity… (page ${i + 1})`);
  }
  const rows = await page.$$eval('li.retableRow', (lis) => lis.map((li) => ({
    date: li.querySelector('.date')?.textContent?.trim() || '',
    title: (li.querySelector('.title a') || li.querySelector('.title'))?.textContent?.trim() || '',
  })));
  return entriesFromRows(rows);
}

/** Opens Netflix, waits for login, returns [{title, date}]. onStatus(state, message). */
export async function syncFromNetflix(onStatus) {
  onStatus('launching', 'Opening a Netflix window…');
  const context = await launch();
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://www.netflix.com/login', { waitUntil: 'domcontentloaded' });
    onStatus('waiting-login', 'Log in to Netflix in the window that just opened, then pick your profile.');
    let active = await waitForUrl(context, (u) => SIGNED_IN.test(u) && !PROFILE_GATE.test(u), 'log in and choose a profile');

    onStatus('reading', 'Reading your viewing activity…');
    await active.goto('https://www.netflix.com/viewingactivity', { waitUntil: 'domcontentloaded' });
    if (PROFILE_GATE.test(active.url()) || /login/i.test(active.url())) {
      onStatus('waiting-login', 'Pick the profile whose history you want to use.');
      active = await waitForUrl(context, (u) => SIGNED_IN.test(u) && !PROFILE_GATE.test(u), 'choose a profile');
      await active.goto('https://www.netflix.com/viewingactivity', { waitUntil: 'domcontentloaded' });
    }
    await active.waitForSelector('li.retableRow, .viewing-activity-footer-download, .retable', { timeout: 30000 }).catch(() => {});

    let entries = await readViaDownload(active).catch(() => null);
    if (!entries?.length) entries = await readViaPage(active, onStatus);
    if (!entries.length) throw new Error('Netflix showed no viewing activity for this profile (or its page layout changed). You can upload the CSV from netflix.com/viewingactivity instead.');
    return entries;
  } finally {
    await context.close().catch(() => {});
  }
}

export function forgetNetflixLogin() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}
