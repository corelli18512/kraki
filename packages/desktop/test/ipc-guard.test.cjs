const test = require('node:test');
const assert = require('node:assert/strict');
const { isAppUrl, senderIsApp, appOnlyIpc } = require('../src/ipc-guard.cjs');
const nav = require('../src/navigation.cjs');

const APP = 'app://kraki';

test('isAppUrl: the app origin and its paths only', () => {
  for (const url of ['app://kraki', 'app://kraki/', 'app://kraki/auth/callback?code=1']) assert.equal(isAppUrl(url, APP), true, url);
  for (const url of ['app://kraki.evil/', 'app://krakix', 'app://other/', 'https://github.com/', 'about:blank', '', null, undefined, 42]) {
    assert.equal(isAppUrl(url, APP), false, String(url));
  }
});

test('senderIsApp judges the sending frame, tolerating missing or disposed frames', () => {
  assert.equal(senderIsApp({ senderFrame: { url: 'app://kraki/' } }, APP), true);
  assert.equal(senderIsApp({ senderFrame: { url: 'https://github.com/login' } }, APP), false);
  assert.equal(senderIsApp({ senderFrame: null }, APP), false);
  assert.equal(senderIsApp({}, APP), false);
  assert.equal(senderIsApp(undefined, APP), false);
  const disposed = { get senderFrame() { return { get url() { throw new Error('Render frame was disposed'); } }; } };
  assert.equal(senderIsApp(disposed, APP), false);
});

test('appOnlyIpc: handle rejects, on drops and answers sync callers with null', async () => {
  const registered = {};
  const ipc = appOnlyIpc({
    handle: (channel, fn) => { registered[channel] = fn; },
    on: (channel, fn) => { registered[channel] = fn; },
  }, APP);
  const seen = [];
  ipc.handle('h', (_e, a) => { seen.push(['h', a]); return 'ok'; });
  ipc.on('o', (e, a) => { seen.push(['o', a]); e.returnValue = 'secret'; });
  const app = () => ({ senderFrame: { url: 'app://kraki/' } });
  const other = () => ({ senderFrame: { url: 'https://github.com/' } });
  assert.equal(await registered.h(app(), 1), 'ok');
  await assert.rejects(async () => registered.h(other(), 2));
  const good = app();
  registered.o(good, 3);
  assert.equal(good.returnValue, 'secret');
  const bad = other();
  registered.o(bad, 4);
  assert.equal(bad.returnValue, null);
  assert.deepEqual(seen, [['h', 1], ['o', 3]]);
});

test('navigation rules', () => {
  assert.equal(nav.mainWindowNavigation('app://kraki/x', APP), 'app');
  assert.equal(nav.mainWindowNavigation('https://github.com/login/oauth/authorize?client_id=x', APP), 'signin');
  assert.equal(nav.mainWindowNavigation('http://github.com/login/oauth/authorize', APP), 'external');
  assert.equal(nav.mainWindowNavigation('https://github.com/login', APP), 'external');
  assert.equal(nav.mainWindowNavigation('https://evil.example/login/oauth/authorize', APP), 'external');
  assert.equal(nav.mainWindowNavigation('file:///etc/passwd', APP), 'block');
  assert.equal(nav.mainWindowNavigation('kraki://auth/callback', APP), 'block');
  assert.equal(nav.isHttpsUrl('https://x/'), true);
  for (const url of ['http://x/', 'file:///x', 'ms-settings:x', 'not a url']) assert.equal(nav.isHttpsUrl(url), false, url);
  assert.equal(nav.webOAuthCallbackToApp('https://app.kraki.chat/auth/callback?code=1', 'https://app.kraki.chat', '/auth/callback', APP),
    'app://kraki/auth/callback?code=1');
  assert.equal(nav.webOAuthCallbackToApp('https://evil.example/auth/callback?code=1', 'https://app.kraki.chat', '/auth/callback', APP), null);
  assert.equal(nav.builtInOAuthCallback('https://app.kraki.chat/auth/callback/desktop?code=1'), 'kraki://auth/callback?code=1');
  assert.equal(nav.builtInOAuthCallback('kraki://auth/callback?code=2'), 'kraki://auth/callback?code=2');
  assert.equal(nav.builtInOAuthCallback('https://app.kraki.chat/auth/callback?code=1'), null);
});
