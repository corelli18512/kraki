const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, request } = require('../src/diag-http.cjs');

const headers = { 'X-Kraki-Device': 'dev_1', 'X-Kraki-Time': '1760000000000', 'X-Kraki-Request': 'r', 'X-Kraki-Signature': 's' };

test('only the two collector paths on an https (or loopback) relay origin', () => {
  assert.equal(validate({ base: 'https://relay.kraki.chat', path: 'config', headers }).url, 'https://relay.kraki.chat/api/diag/v1/config');
  assert.equal(validate({ base: 'http://localhost:4000', path: 'config', headers }).url, 'http://localhost:4000/api/diag/v1/config');
  for (const bad of [
    { base: 'http://relay.kraki.chat', path: 'config' },          // plain http off-loopback
    { base: 'https://relay.kraki.chat/x', path: 'config' },       // not a bare origin
    { base: 'https://u:p@relay.kraki.chat', path: 'config' },     // credentials
    { base: 'https://relay.kraki.chat', path: '../account' },    // other path
    { base: 'file:///c:/x', path: 'config' },
  ]) assert.equal(validate({ ...bad, headers }), null, JSON.stringify(bad));
});

test('header allowlist, POST body bounds, GET without body', () => {
  assert.equal(validate({ base: 'https://r.example', path: 'config', headers: { ...headers, Cookie: 'x' } }), null);
  assert.equal(validate({ base: 'https://r.example', path: 'batch', headers }), null);
  assert.equal(validate({ base: 'https://r.example', path: 'batch', headers, body: new Uint8Array(64 * 1024 + 1) }), null);
  assert.equal(validate({ base: 'https://r.example', path: 'config', headers, body: new Uint8Array(1) }), null);
  assert.equal(validate({ base: 'https://r.example', path: 'batch', headers, body: new Uint8Array(10) }).method, 'POST');
});

test('never follows redirects and reports transport failure as status 0', async () => {
  let init;
  const res = await request(async (_url, i) => { init = i; return { status: 302, text: async () => '' }; }, { base: 'https://r.example', path: 'config', headers });
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
  assert.equal(res.status, 302);
  assert.deepEqual(await request(async () => { throw new Error('offline'); }, { base: 'https://r.example', path: 'config', headers }), { status: 0, body: '' });
  assert.deepEqual(await request(async () => { throw new Error('never called'); }, { base: 'http://evil.example', path: 'config', headers }), { status: 0, body: '' });
});
