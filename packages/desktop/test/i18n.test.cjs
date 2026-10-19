const test = require('node:test');
const assert = require('node:assert');
const i18n = require('../src/i18n.cjs');
const p = require('../src/presence.cjs');

const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();

test('every dictionary has the English keys and placeholders', () => {
  const en = i18n.DICTIONARIES.en;
  for (const [code, dict] of Object.entries(i18n.DICTIONARIES)) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(en).sort(), code);
    for (const k of Object.keys(en)) assert.equal(vars(dict[k]), vars(en[k]), `${code} ${k}`);
  }
});

test('resolves OS languages like the Web client', () => {
  assert.equal(i18n.resolveLanguage(['zh-Hans-CN', 'en-US']), 'zh-Hans');
  assert.equal(i18n.resolveLanguage(['zh-TW', 'en-US']), 'en');
  assert.equal(i18n.resolveLanguage(['fr-FR']), 'en');
  assert.equal(i18n.setLanguage('xx'), false);
});

test('tray follows the language switch', () => {
  const s = { available: true, owned: true, running: true };
  const labels = () => p.trayMenu(p.resolveStatus(s), p.managesPresence(s), [], {}).map((i) => i.label).filter(Boolean);
  assert.ok(labels().includes('Take This PC Offline'));
  i18n.setLanguage('zh-Hans');
  try {
    assert.equal(p.TITLE.online, '这台电脑已上线');
    assert.ok(labels().includes('让这台电脑离线'));
    assert.equal(i18n.t('tray.more', { count: 3 }), '还有 3 个…');
  } finally { i18n.setLanguage('en'); }
});
