import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs build script, no type declarations
import { checkMachOUuid, expectedUuid, LEGACY_NODE_UUIDS, readMachOUuids, setMachOUuid, uuidV5 } from '../../scripts/macho-uuid.mjs';

const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;

/** Minimal 64-bit Mach-O image: header + LC_UUID (+ optional LC_CODE_SIGNATURE). */
function image(cpuType: number, uuid: string, signed = false): Buffer {
  const cmds = signed ? 2 : 1;
  const buf = Buffer.alloc(32 + 24 + (signed ? 16 : 0) + 64);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cpuType, 4);
  buf.writeUInt32LE(2, 12); // MH_EXECUTE
  buf.writeUInt32LE(cmds, 16);
  buf.writeUInt32LE(24 + (signed ? 16 : 0), 20);
  buf.writeUInt32LE(LC_UUID, 32);
  buf.writeUInt32LE(24, 36);
  Buffer.from(uuid.replace(/-/g, ''), 'hex').copy(buf, 40);
  if (signed) {
    buf.writeUInt32LE(LC_CODE_SIGNATURE, 56);
    buf.writeUInt32LE(16, 60);
  }
  return buf;
}

/** Universal binary of the given images, each page-aligned like lipo output. */
function fat(images: Array<{ cpu: number; data: Buffer }>): Buffer {
  const align = 0x1000;
  let offset = align;
  const header = Buffer.alloc(8 + images.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(images.length, 4);
  const parts: Buffer[] = [];
  images.forEach(({ cpu, data }, i) => {
    const at = 8 + i * 20;
    header.writeUInt32BE(cpu, at);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(data.length, at + 12);
    header.writeUInt32BE(12, at + 16);
    parts.push(data);
    offset += align;
  });
  const out = Buffer.alloc(offset);
  header.copy(out, 0);
  parts.forEach((data, i) => data.copy(out, align * (i + 1)));
  return out;
}

describe('macho-uuid', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-macho-uuid-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('produces RFC 4122 version 5 UUIDs that are stable and distinct per seed and arch', () => {
    const a = uuidV5('chat.kraki.cli:arm64');
    expect(a[6] >> 4).toBe(5);
    expect(a[8] >> 6).toBe(2);
    expect(expectedUuid('chat.kraki.cli', 'arm64')).toBe(expectedUuid('chat.kraki.cli', 'arm64'));
    const all = new Set([
      expectedUuid('chat.kraki.cli', 'arm64'),
      expectedUuid('chat.kraki.cli', 'x86_64'),
      expectedUuid('chat.kraki.mac.tentacle', 'arm64'),
      expectedUuid('chat.kraki.mac.tentacle', 'x86_64'),
      ...Object.values(LEGACY_NODE_UUIDS),
    ]);
    expect(all.size).toBe(6);
  });

  it('rewrites a thin binary', () => {
    const path = join(dir, 'thin');
    writeFileSync(path, image(ARM64, LEGACY_NODE_UUIDS.arm64));
    const changes = setMachOUuid(path, 'chat.kraki.cli');
    expect(changes).toEqual([{ arch: 'arm64', from: LEGACY_NODE_UUIDS.arm64, to: expectedUuid('chat.kraki.cli', 'arm64') }]);
    expect(readMachOUuids(path)).toEqual([{ arch: 'arm64', uuid: expectedUuid('chat.kraki.cli', 'arm64') }]);
  });

  it('rewrites every slice of a universal binary and nothing else', () => {
    const path = join(dir, 'fat');
    const before = fat([
      { cpu: X86_64, data: image(X86_64, LEGACY_NODE_UUIDS.x86_64) },
      { cpu: ARM64, data: image(ARM64, LEGACY_NODE_UUIDS.arm64) },
    ]);
    writeFileSync(path, before);
    setMachOUuid(path, 'chat.kraki.mac.tentacle');
    expect(readMachOUuids(path)).toEqual([
      { arch: 'x86_64', uuid: expectedUuid('chat.kraki.mac.tentacle', 'x86_64') },
      { arch: 'arm64', uuid: expectedUuid('chat.kraki.mac.tentacle', 'arm64') },
    ]);
    const after = readFileSync(path);
    expect(after.length).toBe(before.length);
    let differing = 0;
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) differing++;
    expect(differing).toBeLessThanOrEqual(32); // only the two 16-byte UUIDs
  });

  it('check passes only for the seed it was written with', () => {
    const path = join(dir, 'thin');
    writeFileSync(path, image(ARM64, LEGACY_NODE_UUIDS.arm64));
    expect(() => checkMachOUuid(path, 'chat.kraki.cli')).toThrow(/expected/);
    setMachOUuid(path, 'chat.kraki.cli');
    expect(checkMachOUuid(path, 'chat.kraki.cli')).toHaveLength(1);
    expect(() => checkMachOUuid(path, 'chat.kraki.mac.tentacle')).toThrow(/expected/);
  });

  it('is idempotent', () => {
    const path = join(dir, 'thin');
    writeFileSync(path, image(ARM64, LEGACY_NODE_UUIDS.arm64));
    setMachOUuid(path, 'chat.kraki.cli');
    const once = readFileSync(path);
    setMachOUuid(path, 'chat.kraki.cli');
    expect(readFileSync(path).equals(once)).toBe(true);
  });

  it('refuses a signed binary and leaves it untouched', () => {
    const path = join(dir, 'signed');
    const data = image(ARM64, LEGACY_NODE_UUIDS.arm64, true);
    writeFileSync(path, data);
    expect(() => setMachOUuid(path, 'chat.kraki.cli')).toThrow(/code signed/);
    expect(readFileSync(path).equals(data)).toBe(true);
  });

  it('rejects files that are not Mach-O', () => {
    const path = join(dir, 'text');
    writeFileSync(path, Buffer.alloc(64, 0x41));
    expect(() => setMachOUuid(path, 'chat.kraki.cli')).toThrow(/not a little-endian Mach-O/);
  });

  it('CLI rewrites and checks even when invoked through a symlinked path', () => {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/macho-uuid.mjs');
    const linkDir = join(dir, 'link');
    symlinkSync(dirname(script), linkDir);
    const path = join(dir, 'thin');
    writeFileSync(path, image(ARM64, LEGACY_NODE_UUIDS.arm64));
    const viaLink = join(linkDir, 'macho-uuid.mjs');
    const out = execFileSync(process.execPath, [viaLink, 'set', path, 'chat.kraki.cli'], { encoding: 'utf8' });
    expect(out).toContain(`-> ${expectedUuid('chat.kraki.cli', 'arm64')}`);
    expect(() => execFileSync(process.execPath, [viaLink, 'check', path, 'chat.kraki.mac.tentacle'], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync(process.execPath, [viaLink, 'bogus'], { stdio: 'pipe' })).toThrow();
  });

  it.runIf(process.platform === 'darwin')('a real Node binary still signs and runs after the rewrite', () => {
    const path = join(dir, 'node');
    copyFileSync(process.execPath, path);
    execFileSync('codesign', ['--remove-signature', path]);
    const changes = setMachOUuid(path, 'chat.kraki.test');
    expect(changes.length).toBeGreaterThan(0);
    execFileSync('codesign', ['--sign', '-', '--force', path]);
    const out = execFileSync('dwarfdump', ['--uuid', path], { encoding: 'utf8' });
    for (const { arch, to } of changes) expect(out).toContain(`${to} (${arch})`);
    expect(execFileSync(path, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' })).toBe('ok');
  }, 60_000);
});
