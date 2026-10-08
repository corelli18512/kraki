import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HEAD_CONTROL_TYPES } from '@kraki/protocol';

/** Every type the head sends inside `{from:'@head', msg}` must be one the
 *  clients accept from that wrapper; otherwise apps silently drop it (Custom
 *  Words sync broke this way: replies never acknowledged, edits resent). */
describe('head control types', () => {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const sent = new Set<string>();
  for (const m of source.matchAll(/send(?:Control|Presence)ToDevice\([^;]*?type: '([a-z_]+)'/gs)) sent.add(m[1]);
  // Multi-line literals: `{ type: 'x', ... }` assigned first, then sent.
  for (const m of source.matchAll(/const \w+ = \{ type: '([a-z_]+)'/g)) sent.add(m[1]);

  it('finds the control messages', () => {
    expect(sent).toContain('voice_lease_grant');
    expect(sent).toContain('device_removed');
    expect(sent).toContain('preferences_updated');
  });

  it.each([...sent].sort())('%s is an accepted head control type', (type) => {
    expect(HEAD_CONTROL_TYPES.has(type)).toBe(true);
  });

  it('the Mac/iOS app accepts the same types', () => {
    const swift = readFileSync(new URL('../../../arm/ios/Kraki/App/AppState.swift', import.meta.url), 'utf8');
    const block = swift.match(/static let headControlTypes: Set<String> = \[([\s\S]*?)\]/)?.[1] ?? '';
    const native = new Set([...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    expect([...native].sort()).toEqual([...HEAD_CONTROL_TYPES].sort());
  });
});
