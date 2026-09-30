/**
 * The native client's diagnostic vocabulary must be accepted here: an unknown
 * event, field or tag makes the collector reject the whole batch (400) and the
 * client drops it. Parse the Swift sources and compare.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fields, schemas } from '../diag-api.js';

const ios = new URL('../../../arm/ios/Kraki/', import.meta.url).pathname;
const recorder = readFileSync(join(ios, 'Core/Diagnostics/DiagRecorder.swift'), 'utf8');

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? swiftFiles(path) : name.endsWith('.swift') ? [path] : [];
  });
}

describe('native diagnostics vocabulary', () => {
  it('every event name the client can send is allowlisted', () => {
    const block = recorder.slice(recorder.indexOf('enum DiagEventName'), recorder.indexOf('enum DiagField'));
    const names = [...block.matchAll(/= "([\w.]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => !Object.hasOwn(schemas, n))).toEqual([]);
  });

  it('every field the client can send has a validator', () => {
    const block = recorder.slice(recorder.indexOf('enum DiagField'), recorder.indexOf('enum DiagValue'));
    const names = [...block.matchAll(/\b([a-z]\w*)\b/g)].map((m) => m[1])
      .filter((n) => !['enum', 'case', 'string', 'stability', 'summaries', 'stabilitytracker'].includes(n.toLowerCase()));
    expect(names.filter((n) => !Object.hasOwn(fields, n))).toEqual([]);
  });

  it('every literal outbox phase tag is accepted, including automatic resend triggers', () => {
    const sources = swiftFiles(ios).map((p) => readFileSync(p, 'utf8')).join('\n');
    const phases = new Set([...sources.matchAll(/\.phase: \.tag\("([\w]+)"\)/g)].map((m) => m[1]));
    for (const reason of sources.matchAll(/redispatch\(sessionId: [^)]*reason: "(\w+)"\)/g)) phases.add(`resend_${reason[1]}`);
    for (const reason of sources.matchAll(/resendPendingInputs\([^)]*reason: "(\w+)"\)/g)) phases.add(`resend_${reason[1]}`);
    expect(phases.size).toBeGreaterThan(3);
    expect([...phases].filter((p) => !fields.phase(p))).toEqual([]);
  });

  it('every tag value of the stability/send/voice summaries is accepted', () => {
    const src = ['StabilityTracker.swift', 'ExperienceTrackers.swift']
      .map((f) => readFileSync(join(ios, 'Core/Diagnostics', f), 'utf8')).join('\n');
    const cases = (name: string) => [...src.matchAll(new RegExp(`enum ${name}: String \\{ case ([^}]+)\\}`, 'g'))]
      .flatMap((m) => m[1].split(',').map((c) => c.trim()));
    const outcomes = cases('Outcome');
    const kinds = cases('Kind');
    const shown = cases('Shown');
    expect(outcomes.length).toBeGreaterThan(15);
    expect(kinds.length).toBeGreaterThan(5);
    expect(outcomes.filter((v) => !fields.outcome(v))).toEqual([]);
    expect(kinds.filter((v) => !fields.kind(v))).toEqual([]);
    expect(shown.filter((v) => !fields.shown(v))).toEqual([]);
    for (const cause of src.matchAll(/return "([a-z_]+)"/g)) expect(fields.cause(cause[1]), cause[1]).toBe(true);
    for (const stage of src.matchAll(/stage = "([a-z]+)"/g)) expect(fields.stage(stage[1]), stage[1]).toBe(true);
  });
});
