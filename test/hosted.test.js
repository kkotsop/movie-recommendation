import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rawGet } from './helpers.js';

const CODE = 'correct-horse-battery';
let srv;
before(async () => { srv = await startServer({ ACCESS_TOKEN: CODE }); });
after(() => srv.stop());

const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('API is locked until you log in; the app shell and manifest stay public', async () => {
  assert.equal((await srv.call('GET', '/api/state')).status, 401);
  assert.equal((await srv.call('GET', '/api/deck')).status, 401);
  assert.equal((await srv.call('POST', '/api/swipe', { id: 'x', action: 'like' })).status, 401);
  assert.deepEqual((await srv.call('GET', '/api/auth')).json, { required: true, authed: false });
  assert.equal((await srv.call('GET', '/')).status, 200);
  assert.equal((await srv.call('GET', '/manifest.webmanifest')).status, 200);
  assert.equal((await srv.call('GET', '/sw.js')).status, 200);
});

test('wrong code is rejected, right code sets an HttpOnly cookie that unlocks the API', async () => {
  const bad = await srv.call('POST', '/api/login', { code: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  const ok = await srv.call('POST', '/api/login', { code: CODE });
  assert.equal(ok.status, 200);
  const raw = ok.headers.get('set-cookie');
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.ok(!raw.includes(CODE), 'the cookie never contains the access code itself');

  const authed = await srv.call('GET', '/api/state', undefined, { cookie: cookieFrom(ok) });
  assert.equal(authed.status, 200);
  assert.equal((await srv.call('GET', '/api/auth', undefined, { cookie: cookieFrom(ok) })).json.authed, true);
  assert.equal((await srv.call('GET', '/api/state', undefined, { cookie: 'sf_auth=forged' })).status, 401);
});

test('private link /?t=code sets the cookie and redirects without the code', async () => {
  const res = await fetch(`${srv.base}/?t=${CODE}&x=1`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?x=1');
  assert.match(res.headers.get('set-cookie'), /sf_auth=/);
  const wrong = await fetch(`${srv.base}/?t=wrong`, { redirect: 'manual' });
  assert.equal(wrong.status, 302);
  assert.equal(wrong.headers.get('set-cookie'), null);
});

test('hosted mode accepts the public hostname and hides the desktop Netflix login', async () => {
  const login = await srv.call('POST', '/api/login', { code: CODE });
  const headers = { cookie: cookieFrom(login) };
  assert.equal(await rawGet(srv.base, '/', 'swipeflick.example.com'), 200);
  assert.equal((await srv.call('GET', '/api/state', undefined, headers)).json.features.browserLogin, false);
  const connect = await srv.call('POST', '/api/netflix/connect', {}, headers);
  assert.equal(connect.status, 400);
});

test('too many wrong codes are rate limited', async () => {
  const s = await startServer({ ACCESS_TOKEN: CODE });
  try {
    let last;
    for (let i = 0; i < 12; i++) last = await s.call('POST', '/api/login', { code: `wrong${i}` });
    assert.equal(last.status, 429);
    assert.equal((await s.call('POST', '/api/login', { code: CODE })).status, 429, 'even the right code waits out the lockout');
  } finally { s.stop(); }
});

test('without ACCESS_TOKEN the app stays local-only and open on localhost', async () => {
  const s = await startServer();
  try {
    assert.deepEqual((await s.call('GET', '/api/auth')).json, { required: false, authed: true });
    assert.equal((await s.call('GET', '/api/state')).json.features.browserLogin, true);
    assert.equal(await rawGet(s.base, '/api/state', 'swipeflick.example.com'), 403);
  } finally { s.stop(); }
});

test('ALLOWED_HOSTS pins the hosted domain', async () => {
  const s = await startServer({ ACCESS_TOKEN: CODE, ALLOWED_HOSTS: 'swipeflick.example.com' });
  try {
    assert.equal(await rawGet(s.base, '/', 'swipeflick.example.com'), 200);
    assert.equal(await rawGet(s.base, '/', 'evil.example'), 403);
  } finally { s.stop(); }
});
