// Builds ./dist: the UI plus the in-browser engine, ready for static hosting
// (Cloudflare Workers static assets, Pages, Netlify, GitHub Pages, ...).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), dist, { recursive: true });

// Only the pure modules: no fs, no Playwright, no TMDB key handling.
fs.mkdirSync(path.join(dist, 'src'), { recursive: true });
for (const f of ['engine.js', 'history.js', 'recommender.js']) {
  fs.copyFileSync(path.join(root, 'src', f), path.join(dist, 'src', f));
}
fs.mkdirSync(path.join(dist, 'data'), { recursive: true });
fs.copyFileSync(path.join(root, 'data', 'demo-catalog.json'), path.join(dist, 'data', 'demo-catalog.json'));

fs.writeFileSync(path.join(dist, 'swipeflick-extension.zip'), zipDirectory(path.join(root, 'extension'), 'swipeflick-extension'));

fs.writeFileSync(path.join(dist, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/data/*
  Cache-Control: public, max-age=3600
`);

const files = fs.readdirSync(dist, { recursive: true }).filter((f) => fs.statSync(path.join(dist, f)).isFile());
console.log(`Built ${files.length} files into dist/`);
