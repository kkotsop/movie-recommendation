import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

/** Starts server.js on a free port with an empty data dir. Returns {base, call, stop}. */
export async function startServer(env = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swipeflick-api-'));
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SWIPEFLICK_DATA: dir, TMDB_API_KEY: '', HOSTED: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${log}`)), 10000);
    child.stdout.on('data', (d) => { log += d; if (log.includes('is running')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${log}`)); });
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
  const stop = () => { child.removeAllListeners('exit'); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { base, call, stop, dir };
}

/** Raw GET with an arbitrary Host header (fetch won't let you set one). */
export function rawGet(base, pathname, host) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}
