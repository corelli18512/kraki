import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, emptyState } from '../lib/engine.mjs';
import { evaluateRules } from '../lib/rules.mjs';

const bark = fileURLToPath(new URL('../../bark/', import.meta.url));

test('proxy edits preserve existing relay/collector routes and reject duplicate or unknown layouts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bark-proxy-test-'));
  try {
    const fixtures = {
      caddy: 'other.example {\n respond ok\n}\nrelay.kraki.chat {\n\t@diagnostics path /api/diag/v1/*\n\treverse_proxy @diagnostics 127.0.0.1:4011\n\treverse_proxy localhost:4000\n}\n',
      nginx: 'server {\n    # Independent log collector; WebSocket/Head routing stays unchanged.\n    location / { proxy_pass http://127.0.0.1:4000; }\n}\n',
    };
    for (const [kind, text] of Object.entries(fixtures)) {
      const path = join(dir, kind);
      writeFileSync(path, text);
      const r = spawnSync('python3', [join(bark, 'proxy-config.py'), kind, path], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /127\.0\.0\.1:4080/);
      assert.match(r.stdout, /\/bark\/ping/);
      assert.match(r.stdout, /\/bark\/register/);
      assert.match(r.stdout, /404/);
      assert.doesNotMatch(r.stdout, /location.*\/bark\/push|path.*\/bark\/push/);
      assert.match(r.stdout, /(?:localhost|127\.0\.0\.1):4000/);
      assert.equal(readFileSync(path, 'utf8'), text, 'rendering must not modify source');
      writeFileSync(path, r.stdout);
      assert.notEqual(spawnSync('python3', [join(bark, 'proxy-config.py'), kind, path]).status, 0);
      writeFileSync(path, 'unknown layout');
      assert.notEqual(spawnSync('python3', [join(bark, 'proxy-config.py'), kind, path]).status, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Bark deployment pins binaries, binds loopback, and disables request logs', () => {
  const unit = readFileSync(join(bark, 'bark.service'), 'utf8');
  assert.match(unit, /--addr 127\.0\.0\.1:4080 --url-prefix \/bark/);
  assert.match(unit, /User=kraki-bark/);
  assert.match(unit, /StandardOutput=null\nStandardError=null/);
  assert.match(unit, /StateDirectoryMode=0700/);
  const script = readFileSync(join(bark, 'install.sh'), 'utf8');
  assert.match(script, /VERSION=v2\.3\.9/);
  assert.match(script, /sha256sum -c -/);
  assert.doesNotMatch(script, /systemctl (restart|stop) (kraki-relay|caddy|nginx)/);
  assert.equal(spawnSync('sh', ['-n', join(bark, 'install.sh')]).status, 0);
});

test('each host checks its local Bark and the other host independently', () => {
  for (const [host, peer] of [['tokyo', 'cn'], ['cn', 'tokyo']]) {
    const config = JSON.parse(readFileSync(new URL(`../config/${host}.json`, import.meta.url), 'utf8'));
    assert.ok(config.units.some((u) => u.unit === 'kraki-bark' && u.severity === 'critical'));
    const local = config.probes.find((p) => p.id === 'K-BARK-DOWN');
    assert.equal(local.url, 'http://127.0.0.1:4080/bark/ping');
    const remote = config.probes.find((p) => p.id === 'K-BARK-PEER');
    assert.equal(remote.target, peer);
    assert.match(remote.url, /^https:\/\/.+\/bark\/ping$/);
    let state = emptyState();
    let mem = {};
    let notifications = [];
    for (let i = 0; i < remote.failAfter; i++) {
      const now = Date.parse('2026-10-15T06:00:00Z') + i * 60_000;
      const r = evaluateRules({ now, probes: [{ ...remote, ok: false, detail: 'HTTP 502', ms: 2 }] }, mem, config);
      mem = r.mem;
      const out = evaluate(state, r.results, now, config);
      state = out.state;
      notifications.push(...out.notifications);
    }
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].severity, 'critical');
    assert.match(notifications[0].title, /Bark/);
  }
});
