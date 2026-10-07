#!/usr/bin/env node
/**
 * Give a Kraki executable its own Mach-O build UUID (LC_UUID).
 *
 * Why: the CLI and the helper embedded in Kraki for Mac are both the official
 * Node.js binary with a SEA blob injected. Injection does not touch LC_UUID, so
 * every Kraki build ever shipped carried Node's UUID — the CLI, the helper, and
 * every version of each. macOS local network privacy identifies a process that
 * has no Launch Services identity (the helper, which launchd executes directly)
 * by its main executable UUID. With the UUID shared, the helper was attributed
 * to the CLI (chat.kraki.cli): the user was never asked for the helper, and the
 * helper's agents could not reach the local network. Apple TN3179 / TN3178:
 * distinct apps must have distinct main executable UUIDs.
 *
 * The UUID is an RFC 4122 v5 UUID of "<seed>:<arch>". Use the bundle id as the
 * seed: each product and architecture then gets its own UUID that stays the
 * same across releases, so a local network grant survives updates (a per-build
 * UUID makes macOS re-check the grant after every update).
 *
 * Run on an UNSIGNED binary (the signature covers the load commands) and sign
 * afterwards. Works on thin and universal (fat) binaries.
 *
 *   node macho-uuid.mjs set <binary> <seed>   rewrite every slice, print old -> new
 *   node macho-uuid.mjs get <binary>          print "<arch> <UUID>" per slice
 *   node macho-uuid.mjs check <binary> <seed> fail unless every slice has the seed's UUID
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;
const CPU_NAMES = new Map([[0x0100000c, 'arm64'], [0x01000007, 'x86_64']]);

/** Fixed namespace for Kraki executables. Never change it: it would change every UUID. */
export const KRAKI_UUID_NAMESPACE = '6f1d3a0e-8c3b-4f5e-9a51-6b72616b6921';

/** Node's own LC_UUIDs that shipped in Kraki builds before this fix. */
export const LEGACY_NODE_UUIDS = Object.freeze({
  arm64: '1466DF1D-C8AC-3300-8668-B80CC02F2756',
  x86_64: 'BEAF7B90-3F88-3778-A015-F60CF5C37B4F',
});

function uuidBytes(text) {
  return Buffer.from(text.replace(/-/g, ''), 'hex');
}

function formatUuid(bytes) {
  const h = Buffer.from(bytes).toString('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** RFC 4122 version 5 (SHA-1, name-based) UUID bytes. */
export function uuidV5(name, namespace = KRAKI_UUID_NAMESPACE) {
  const hash = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

export function archName(cpuType) {
  return CPU_NAMES.get(cpuType >>> 0) ?? `cpu-0x${(cpuType >>> 0).toString(16)}`;
}

/** The UUID a given seed produces for a given architecture name. */
export function expectedUuid(seed, arch) {
  return formatUuid(uuidV5(`${seed}:${arch}`));
}

/** Byte offsets and CPU types of every Mach-O image in the file. */
function slices(buf) {
  const magic = buf.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const count = buf.readUInt32BE(4);
    const entrySize = magic === FAT_MAGIC_64 ? 32 : 20;
    const out = [];
    for (let i = 0; i < count; i++) {
      const at = 8 + i * entrySize;
      const cpuType = buf.readUInt32BE(at);
      const offset = magic === FAT_MAGIC_64 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
      out.push({ cpuType, offset });
    }
    return out;
  }
  return [{ cpuType: buf.readUInt32LE(4), offset: 0 }];
}

/** Locate LC_UUID / LC_CODE_SIGNATURE in each slice. Throws on anything unexpected. */
function scan(buf, path) {
  return slices(buf).map(({ cpuType, offset }) => {
    const arch = archName(cpuType);
    const magic = buf.readUInt32LE(offset);
    if (magic !== MH_MAGIC_64 && magic !== MH_MAGIC) {
      throw new Error(`${path}: ${arch} slice at 0x${offset.toString(16)} is not a little-endian Mach-O image`);
    }
    const ncmds = buf.readUInt32LE(offset + 16);
    let p = offset + (magic === MH_MAGIC_64 ? 32 : 28);
    let uuidAt = -1;
    let signed = false;
    for (let i = 0; i < ncmds; i++) {
      const cmd = buf.readUInt32LE(p);
      const size = buf.readUInt32LE(p + 4);
      if (size < 8) throw new Error(`${path}: ${arch} has a malformed load command`);
      if (cmd === LC_UUID) uuidAt = p + 8;
      if (cmd === LC_CODE_SIGNATURE) signed = true;
      p += size;
    }
    if (uuidAt < 0) throw new Error(`${path}: ${arch} slice has no LC_UUID`);
    return { arch, uuidAt, signed };
  });
}

/** [{ arch, uuid }] for every slice. */
export function readMachOUuids(path) {
  const buf = readFileSync(path);
  return scan(buf, path).map(({ arch, uuidAt }) => ({ arch, uuid: formatUuid(buf.subarray(uuidAt, uuidAt + 16)) }));
}

/**
 * Rewrite every slice's LC_UUID to uuidV5("<seed>:<arch>"). The binary must be
 * unsigned. Returns [{ arch, from, to }].
 */
export function setMachOUuid(path, seed) {
  if (!seed) throw new Error('seed is required');
  const buf = readFileSync(path);
  const found = scan(buf, path);
  const signedArch = found.find((s) => s.signed)?.arch;
  if (signedArch) {
    throw new Error(`${path}: ${signedArch} slice is code signed; run \`codesign --remove-signature\` first`);
  }
  const changes = found.map(({ arch, uuidAt }) => {
    const from = formatUuid(buf.subarray(uuidAt, uuidAt + 16));
    const next = uuidV5(`${seed}:${arch}`);
    next.copy(buf, uuidAt);
    return { arch, from, to: formatUuid(next) };
  });
  writeFileSync(path, buf);
  return changes;
}

/** Throw unless every slice carries the UUID derived from `seed` (never Node's). */
export function checkMachOUuid(path, seed) {
  const slicesFound = readMachOUuids(path);
  for (const { arch, uuid } of slicesFound) {
    if (Object.values(LEGACY_NODE_UUIDS).includes(uuid) || uuid !== expectedUuid(seed, arch)) {
      throw new Error(`${path}: ${arch} has LC_UUID ${uuid}, expected ${expectedUuid(seed, arch)} (${seed})`);
    }
  }
  return slicesFound;
}

function main(argv) {
  const [command, path, seed] = argv;
  if (command === 'set' && path && seed) {
    for (const { arch, from, to } of setMachOUuid(path, seed)) console.log(`${arch}: ${from} -> ${to}`);
    return;
  }
  if (command === 'get' && path) {
    for (const { arch, uuid } of readMachOUuids(path)) console.log(`${arch} ${uuid}`);
    return;
  }
  if (command === 'check' && path && seed) {
    for (const { arch, uuid } of checkMachOUuid(path, seed)) console.log(`${arch} ${uuid} ok (${seed})`);
    return;
  }
  console.error('usage: macho-uuid.mjs set <binary> <seed> | get <binary> | check <binary> <seed>');
  process.exit(2);
}

/** Run as a script? Compare real paths: /tmp -> /private/tmp style symlinks
 *  must not make a build step silently do nothing. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`macho-uuid: ${err.message}`);
    process.exit(1);
  }
}
