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

test('dialog and shell errors preserve English and translate at call time', async () => {
  const { probeCli } = require('../src/settings.cjs');
  const { BuiltInKraki } = require('../src/tentacle.cjs');
  const builtIn = new BuiltInKraki({ resourcesPath: '', appPath: '', appVersion: '' });
  builtIn.available = () => false;
  for (const [language, locate, executable, invalid, missing, failed] of [
    ['en', 'Locate kraki manually', 'Kraki executable', 'Select an existing kraki executable.', 'The built-in Kraki is missing from this installation.', 'Kraki did not start. See the logs in C:\\Kraki\\logs'],
    ['zh-Hans', '定位 kraki 可执行文件', 'Kraki 可执行文件', '请选择现有的 kraki 可执行文件。', '此安装中缺少内置 Kraki。', 'Kraki 未能启动。请查看 C:\\Kraki\\logs 中的日志。'],
  ]) {
    i18n.setLanguage(language);
    try {
      assert.equal(i18n.t('dialog.locateTitle'), locate);
      assert.equal(i18n.t('dialog.executable'), executable);
      assert.equal(i18n.t('error.startFailed', { path: 'C:\\Kraki\\logs' }), failed);
      await assert.rejects(probeCli('not-a-kraki-executable'), { message: invalid });
      await assert.rejects(builtIn.enable(), { message: missing });
    } finally { i18n.setLanguage('en'); }
  }
});

test('a saved English choice is valid even though it is the current language', () => {
  i18n.setLanguage('en');
  assert.equal(i18n.isLanguage('en'), true);
  assert.equal(i18n.isLanguage('xx'), false);
  assert.equal(i18n.isLanguage(undefined), false);
});
