'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const config = require('../cloud-config');
const { Store } = require('../storage');
const { CloudAccount, message, cloudFetch } = require('../cloud-account');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from('encrypted:' + Buffer.from(text).toString('base64')),
  decryptString: bytes => { const text = bytes.toString(); if (!text.startsWith('encrypted:')) throw Error('unreadable'); return Buffer.from(text.slice(10), 'base64').toString(); }
};
test('cloud errors explain connection failures without exposing session details', () => {
  for (const [error, expected] of [
    [{ name: 'TimeoutError' }, /не ответило вовремя/],
    [{ message: 'TypeError: fetch failed', details: 'Caused by ENOTFOUND secret-token' }, /найти адрес/],
    [{ message: 'net::ERR_PROXY_CONNECTION_FAILED secret-token' }, /через VPN/],
    [{ cause: { code: 'CERT_HAS_EXPIRED' } }, /защищённое соединение/],
    [{ message: 'TypeError: fetch failed secret-token' }, /Соединение.*прервано/],
    [{ code: 'PGRST202', message: 'secret-token' }, /не настроен/]
  ]) {
    const result = message(error); assert.match(result, expected); assert.equal(result.includes('secret-token'), false);
  }
});
test('cloud transport keeps caller cancellation and sets a deadline even with a caller signal', async () => {
  const originalTimeout = AbortSignal.timeout, deadlines = [], requests = [];
  AbortSignal.timeout = ms => { deadlines.push(ms); return originalTimeout(ms); };
  try {
    const fetch = cloudFetch(async (url, options) => { requests.push({ url, options }); return 'response'; });
    const caller = new AbortController();
    assert.equal(await fetch('https://example.com/auth/v1/token', { method: 'POST', signal: caller.signal }), 'response');
    await fetch('https://example.com/storage/v1/object/files/hash', { body: Buffer.from('file') });
    assert.deepEqual(deadlines, [25000, 120000]);
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.signal.aborted, false);
    caller.abort(); assert.equal(requests[0].options.signal.aborted, true);
    assert.equal(requests[1].options.body.toString(), 'file');
  } finally { AbortSignal.timeout = originalTimeout; }
});
test('official SDK: encrypted login, two accounts isolated, restart and sign-out', async t => {
  const old = { ...config }, records = new Map(), sessions = new Map();
  const users = { 'alice@example.com': '11111111-1111-4111-8111-111111111111', 'bob@example.com': '22222222-2222-4222-8222-222222222222' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    let body = ''; for await (const chunk of req) body += chunk;
    if (url.pathname === '/auth/v1/token') {
      const input = JSON.parse(body), uid = users[input.email];
      if (!uid || input.password !== 'test-password') return send(400, { error_code: 'invalid_credentials', msg: 'Invalid login' });
      const token = Buffer.from(uid).toString('base64'); sessions.set(token, uid);
      return send(200, { access_token: token, refresh_token: 'refresh-' + uid, expires_in: 3600, token_type: 'bearer', user: { id: uid, email: input.email, aud: 'authenticated', role: 'authenticated' } });
    }
    if (url.pathname === '/auth/v1/logout') return send(200, {});
    const uid = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
    if (!uid) return send(401, { message: 'Unauthorized' });
    if (!records.has(uid)) records.set(uid, {});
    const own = records.get(uid);
    if (url.pathname === '/rest/v1/snowball_records') {
      const cursor = (url.searchParams.get('key') || 'gt.').slice(3);
      return send(200, Object.values(own).filter(r => r.key > cursor).sort((a, b) => a.key.localeCompare(b.key)).slice(0, 500));
    }
    if (url.pathname === '/rest/v1/rpc/snowball_put') {
      const input = JSON.parse(body), previous = own[input.p_key];
      if ((previous?.version || 0) !== input.p_expected) return send(200, { ok: false, record: previous });
      const record = { key: input.p_key, version: input.p_expected + 1, payload: input.p_payload }; own[input.p_key] = record;
      return send(200, { ok: true, record });
    }
    return send(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.url = 'http://127.0.0.1:' + server.address().port; config.key = 'publishable-test';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-account-test-')), accounts = [];
  t.after(async () => {
    for (const account of accounts) { clearInterval(account.timer); account.client.auth.stopAutoRefresh(); await account.queue; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    Object.assign(config, old); await fs.rm(root, { recursive: true, force: true });
  });
  async function make(name) {
    const dir = path.join(root, name); await fs.mkdir(dir, { recursive: true });
    const store = await new Store(path.join(dir, 'data')).init();
    const account = new CloudAccount({ userData: dir, safeStorage, getStore: () => store, lock: (_store, fn) => fn(), changed: () => {}, emit: () => {}, backup: async () => 'test-backup' });
    accounts.push(account); await account.start(); return { account, store, dir };
  }
  const a = await make('desktop'), b = await make('laptop');
  const bad = await a.account.auth('signin', 'alice@example.com', 'wrong-password'); assert.equal(bad.ok, false); assert.match(bad.error, /Почта или пароль/);
  const task = await a.store.saveTask({ title: 'С компьютера' });
  assert.equal((await a.account.auth('signin', 'alice@example.com', 'test-password')).ok, true);
  assert.equal((await a.account.sync()).ok, true);
  const encrypted = await fs.readFile(path.join(a.dir, 'cloud-session.bin'), 'utf8');
  assert.equal(encrypted.includes('alice@example.com'), false); assert.equal(encrypted.includes('access_token'), false);
  assert.equal((await b.account.auth('signin', 'alice@example.com', 'test-password')).ok, true);
  assert.equal((await b.account.sync()).ok, true); assert.equal(b.store.findTask(task.id).title, 'С компьютера');
  const restarted = await make('desktop'); await restarted.account.sync(); assert.equal(restarted.account.status.email, 'alice@example.com');
  assert.equal((await b.account.auth('signout')).ok, true);
  await assert.rejects(fs.stat(path.join(b.dir, 'cloud-session.bin')), { code: 'ENOENT' });
  assert.equal(b.store.findTask(task.id).title, 'С компьютера');
  await b.account.auth('signin', 'bob@example.com', 'test-password');
  assert.equal((await b.account.sync()).ok, false); assert.match(b.account.status.error, /другим аккаунтом/);
  assert.equal(Object.keys(records.get(users['bob@example.com']) || {}).length, 0);
});
