const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLocalLinkDiscovery } = require('../src/tentacle.cjs');

test('local-link discovery: returns the record, null when missing or oversized', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kraki-home-'));
  try {
    assert.equal(readLocalLinkDiscovery(home), null);
    const body = JSON.stringify({ v: 1, port: 51234, tentacleId: 'dev_x' });
    fs.writeFileSync(path.join(home, 'local-link.json'), body);
    assert.equal(readLocalLinkDiscovery(home), body);
    fs.writeFileSync(path.join(home, 'local-link.json'), 'x'.repeat(5000));
    assert.equal(readLocalLinkDiscovery(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
