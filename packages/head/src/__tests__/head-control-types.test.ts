import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { HEAD_CONTROL_TYPES } from '@kraki/protocol';

/** Every type the head sends inside `{from:'@head', msg}` must be one the
 *  clients accept from that wrapper; otherwise apps silently drop it (Custom
 *  Words sync broke this way: replies never acknowledged, edits resent). */
describe('head control types', () => {
  // HeadServer and its handler modules (server/*.ts).
  const serverDir = new URL('../server/', import.meta.url);
  const source = [new URL('../server.ts', import.meta.url),
    ...readdirSync(serverDir).filter((f) => f.endsWith('.ts')).map((f) => new URL(f, serverDir))]
    .map((file) => readFileSync(file, 'utf8')).join('\n');
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
    // AppState and its extensions (AppState+*.swift).
    const appDir = new URL('../../../arm/ios/Kraki/App/', import.meta.url);
    const swift = readdirSync(appDir).filter((f) => /^AppState(\+.*)?\.swift$/.test(f))
      .map((f) => readFileSync(new URL(f, appDir), 'utf8')).join('\n');
    const block = swift.match(/static let headControlTypes: Set<String> = \[([\s\S]*?)\]/)?.[1] ?? '';
    const native = new Set([...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    expect([...native].sort()).toEqual([...HEAD_CONTROL_TYPES].sort());
  });
});
