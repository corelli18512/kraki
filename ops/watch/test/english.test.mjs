import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { barkPayload } from '../lib/bark.mjs';
import { formatDigest } from '../lib/digest.mjs';
import { emptyState, evaluate } from '../lib/engine.mjs';
import { experienceChecks } from '../lib/experience.mjs';
import { evaluateRules } from '../lib/rules.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const han = /\p{Script=Han}/u;
const now = Date.parse('2026-10-15T06:00:00Z');

test('operational notification sources and shipped host labels are English-only', () => {
  const files = ['../kraki-watch.mjs', '../../insights/metrics.py', '../config/tokyo.json', '../config/cn.json',
    ...readdirSync(new URL('../lib/', import.meta.url)).filter(name => name.endsWith('.mjs')).map(name => `../lib/${name}`)];
  for (const file of files) assert.doesNotMatch(read(file), han, file);
});

test('real Python cohort titles flow into English-only daily and alert payloads for both hosts', () => {
  const metrics = JSON.parse(execFileSync('python3', ['-B', '-c', `
import json
from metrics import SPECS, distributions
now=${now}
events=[]
for event,(metric,title,field,outcome,target) in SPECS.items():
    events.append(dict(owner='a'*64,platform='ios',version='1.0(1)',ev=event,t=now-1000,
        d={field:100,'outcome':outcome,'offline':False,'background':False,'deltas':3}))
print(json.dumps(distributions(events,now-900000,now)[0]))
`], { cwd: fileURLToPath(new URL('../../insights/', import.meta.url)), encoding: 'utf8' }));
  assert.equal(metrics.length, 6);
  assert.ok(metrics.some(g => g.title === 'Send confirmation'));
  assert.ok(metrics.some(g => g.title === 'Reply first text (observed)'));
  for (const host of ['tokyo', 'cn']) {
    const config = JSON.parse(read(`../config/${host}.json`));
    assert.equal(config.label, host === 'tokyo' ? 'Tokyo' : 'China');
    const insights = { schema: 1, host, asOf: now, recent: metrics, daily: { date: '2026-10-14', metrics },
      quality: { scan: {}, latestEventAt: now - 1000 }, product: { registration: { total: 5, newByDay: { '2026-10-14': 0 } },
        days: { '2026-10-14': { observedDau: null, dayComplete: false } } } };
    const checks = evaluateRules({ now, backup: null, insights, probes: config.probes.map(p => ({ ...p, ok: true, ms: 10 })), units: [] }, {}, config);
    const { state } = evaluate(emptyState(), checks.results, now, config);
    state.day.notes = checks.digest.notes;
    for (const probe of config.probes) state.day.probes[probe.name] = { checks: 1, fails: 0 };
    const note = formatDigest(state, now, config);
    const payload = barkPayload(note, 'test-key');
    assert.match(note.title, /^Kraki Daily · (Tokyo|China) · 1 issue$/);
    assert.match(note.body, /Database backup status missing/);
    assert.match(note.body, /Active yesterday unknown/);
    assert.match(note.body, /Uploaded iOS\/Mac samples only/);
    assert.doesNotMatch(JSON.stringify(payload), han);
    assert.equal(payload.level, 'passive');
    assert.equal(payload.sound, 'silence');
    assert.equal(payload.group, 'Kraki Daily');
    assert.equal(payload.call, undefined);
    assert.equal(payload.volume, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 3500);
    const rules = experienceChecks(insights, now, config, {}).rules;
    assert.doesNotMatch(JSON.stringify(rules), han);
    assert.ok(rules.every(r => r.notify === false), 'language changes must not enable experience alerts');
  }
});
