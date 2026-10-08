const test = require('node:test');
const assert = require('node:assert');
const { allowRequest, allowCheck } = require('../src/permissions.cjs');

const APP = 'app://kraki';
test('the app may write the clipboard (Copy buttons) but not read it', () => {
  assert.equal(allowRequest('clipboard-sanitized-write', {}, `${APP}/index.html`, APP), true);
  assert.equal(allowCheck('clipboard-sanitized-write', APP, APP), true);
  assert.equal(allowRequest('clipboard-read', {}, `${APP}/index.html`, APP), false);
  assert.equal(allowCheck('clipboard-read', APP, APP), false);
});

test('microphone only, and only for the app itself', () => {
  assert.equal(allowRequest('media', { mediaTypes: ['audio'] }, `${APP}/`, APP), true);
  assert.equal(allowRequest('media', { mediaTypes: ['audio', 'video'] }, `${APP}/`, APP), false);
  assert.equal(allowRequest('media', { mediaTypes: ['audio'] }, 'https://github.com/login', APP), false);
  assert.equal(allowCheck('media', 'https://github.com', APP), false);
  assert.equal(allowRequest('clipboard-sanitized-write', {}, 'https://github.com/', APP), false);
  assert.equal(allowRequest('clipboard-sanitized-write', {}, 'app://krakievil/', APP), false);
});

test('everything else is refused', () => {
  for (const p of ['notifications', 'geolocation', 'openExternal', 'fullscreen', 'midi']) {
    assert.equal(allowRequest(p, {}, `${APP}/`, APP), false, p);
    assert.equal(allowCheck(p, APP, APP), false, p);
  }
});
