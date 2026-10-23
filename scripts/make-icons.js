// Renders the Swipeflix mark into the PNG icons a phone needs for "Add to Home Screen".
// Usage: node scripts/make-icons.js   (needs Chrome/Edge or `npx playwright install chromium`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ACCENT = '#E5481F';

// The mark: a back card and a front card with a play button, white on the accent colour.
const mark = `<rect x="3.4" y="6.6" width="11" height="14" rx="2.6" transform="rotate(-9 8.9 13.6)" fill="#fff" opacity=".45"/>
  <rect x="7.4" y="3.6" width="12.4" height="16.8" rx="3" fill="#fff"/><path d="M11.7 8.4v7.2l5.5-3.6z" fill="${ACCENT}"/>`;

// `scale` is how much of the tile the mark fills. Maskable icons keep it inside the 80% safe zone, and iOS rounds corners itself.
const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 0.78, radius: 0.23 },
  { file: 'icon-512.png', size: 512, scale: 0.78, radius: 0.23 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.6, radius: 0 },
  { file: 'apple-touch-icon.png', size: 180, scale: 0.72, radius: 0 },
];

let browser;
for (const channel of ['chrome', 'msedge', undefined]) {
  try { browser = await chromium.launch({ channel }); break; } catch {}
}
if (!browser) throw new Error('No Chrome/Edge/Chromium available');

for (const { file, size, scale, radius } of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = size * scale;
  await page.setContent(`<style>html,body{margin:0;background:transparent}
    .t{width:${size}px;height:${size}px;border-radius:${radius * size}px;background:${ACCENT};display:grid;place-items:center}
    svg{width:${inner}px;height:${inner}px}</style><div class="t"><svg viewBox="0 0 24 24">${mark}</svg></div>`);
  await page.screenshot({ path: path.join(PUBLIC, file), omitBackground: true });
  await page.close();
  console.log('wrote', file);
}
await browser.close();
