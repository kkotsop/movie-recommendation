import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

/**
 * Starts the real Worker locally (Wrangler's local runtime, with its own R2 and Durable Object storage)
 * on a free port with empty storage. Returns {base, call, stop, dir}.
 * `vars` become Worker variables/secrets, e.g. {TMDB_API_KEY: '...'}.
 */
export async function startServer(vars = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swipeflix-worker-'));
  const args = [WRANGLER, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', dir, '--inspector-port', '0', '--test-scheduled'];
  // Tests never touch the real internet: with no catalog source given, every country's catalog is simply "not built".
  for (const [k, v] of Object.entries({ CATALOG_BASE: 'http://127.0.0.1:9/none', ...vars })) args.push('--var', `${k}:${v}`);
  const child = spawn(process.execPath, args, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, // own process group, so stopping it also stops workerd
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1', WRANGLER_LOG_PATH: path.join(dir, 'logs') },
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not start: ${log}`)), 60000);
    const onData = (d) => { log += d; if (log.includes('Ready on')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`worker exited (${code}): ${log}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body == null ? {} : { 'content-type': typeof body === 'string' ? 'text/csv' : 'application/json' }), ...headers },
      body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const stop = () => {
    child.removeAllListeners('exit');
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500).unref();
  };
  return { base, call, stop, dir, port };
}
