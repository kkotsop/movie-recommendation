// Renders public/icon.svg into the PNG icons a phone needs for "Add to Home Screen".
// Usage: node scripts/make-icons.js   (needs Chrome/Edge or `npx playwright install chromium`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = fs.readFileSync(path.join(PUBLIC, 'icon.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');

// scale = how much of the tile the flame fills. Maskable icons keep it inside the 80% safe zone.
const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 0.62, radius: 0.22 },
  { file: 'icon-512.png', size: 512, scale: 0.62, radius: 0.22 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.5, radius: 0 },
  { file: 'apple-touch-icon.png', size: 180, scale: 0.6, radius: 0 }, // iOS rounds the corners itself
];

let browser;
for (const channel of ['chrome', 'msedge', undefined]) {
  try { browser = await chromium.launch({ channel }); break; } catch {}
}
if (!browser) throw new Error('No Chrome/Edge/Chromium available');

for (const { file, size, scale, radius } of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}
    .t{width:${size}px;height:${size}px;border-radius:${radius * size}px;background:radial-gradient(circle at 30% 20%,#1b2030,#0e1014 70%);display:grid;place-items:center}
    svg{width:${size * scale}px;height:${size * scale}px}</style><div class="t">${svg}</div>`);
  await page.screenshot({ path: path.join(PUBLIC, file), omitBackground: true });
  await page.close();
  console.log('wrote', file);
}
await browser.close();
