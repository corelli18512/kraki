/**
 * Content-addressed attachment store for a Kraki session.
 *
 * Disk layout, per session:
 *
 *   <sessionsDir>/<sessionId>/attachments/
 *     <id>.<ext>     ← raw bytes
 *     <id>.json      ← sidecar metadata { mimeType, size, name?, width?, height? }
 *
 * `id` is the lowercase hex of `sha256(bytes)` truncated to 32 chars
 * (128-bit space — collision is astronomical for one user's content).
 *
 * Writes are idempotent: if a file with the same hash already exists,
 * `put()` returns the existing ref without re-writing the bytes.
 *
 * The store is purely a tentacle-internal concern. The MCP server doesn't
 * touch it directly — the adapter writes here when it observes image
 * content blocks in tool_complete events, and the relay-client reads here
 * when it needs to broadcast `attachment_data` chunks or serve a
 * `request_attachment`.
 */

import { renameWithRetry } from './fs-retry.js';
import {
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { ContentRef } from '@kraki/protocol';

import { createLogger } from './logger.js';
import { isSafeId } from './session-manager.js';

const logger = createLogger('attachment-store');

/** Sidecar persisted alongside each attachment file. */
interface AttachmentMetaSidecar {
  mimeType: string;
  size: number;
  name?: string;
  width?: number;
  height?: number;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** PNG/JPEG header sniffing — returns intrinsic dimensions when cheap. */
function readImageDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png' && bytes.length >= 24) {
      // PNG: bytes 16..20 = width (big-endian uint32), 20..24 = height
      if (
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      ) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      }
    }
    if (mimeType === 'image/jpeg') {
      // JPEG: walk segments looking for SOFn (0xC0..0xCF except 0xC4/0xC8/0xCC)
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) break;
        const marker = bytes[i + 1];
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        // Standalone markers without length payload
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        // SOFn: 0xC0..0xCF except DHT(0xC4), JPG(0xC8), DAC(0xCC)
        if (
          marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        ) {
          // Layout after marker: 2-byte length, 1-byte precision, 2-byte height, 2-byte width
          const height = bytes.readUInt16BE(i + 5);
          const width = bytes.readUInt16BE(i + 7);
          return { width, height };
        }
        const segLen = bytes.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    }
    if (mimeType === 'image/webp' && bytes.length >= 30) {
      // VP8X chunk has width/height; VP8L/VP8 simpler variants too.
      // Layout: 'RIFF' [size:4] 'WEBP' [chunk fourcc:4] ...
      if (
        bytes.slice(0, 4).toString('ascii') === 'RIFF' &&
        bytes.slice(8, 12).toString('ascii') === 'WEBP'
      ) {
        const fourcc = bytes.slice(12, 16).toString('ascii');
        if (fourcc === 'VP8X') {
          // Canvas Width Minus One: 24bits LE at offset 24, Height: offset 27
          const w = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
          const h = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
          return { width: w + 1, height: h + 1 };
        }
        if (fourcc === 'VP8L' && bytes.length >= 25) {
          // 14-bit width and height encoded after 1 signature byte at offset 21
          const b0 = bytes[21];
          const b1 = bytes[22];
          const b2 = bytes[23];
          const b3 = bytes[24];
          const width = 1 + ((((b1 & 0x3f) << 8) | b0));
          const height = 1 + ((((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && bytes.length >= 30) {
          // Lossy: width and height in 14 bits each at offsets 26 and 28
          const width = bytes.readUInt16LE(26) & 0x3fff;
          const height = bytes.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    }
    if (mimeType === 'image/gif' && bytes.length >= 10) {
      // GIF: 'GIF89a' or 'GIF87a', then width (LE u16) at offset 6, height at 8
      const sig = bytes.slice(0, 6).toString('ascii');
      if (sig === 'GIF89a' || sig === 'GIF87a') {
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
      }
    }
  } catch {
    // Best-effort — never throw out of header sniffing
  }
  return null;
}

function extForMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? 'bin';
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

export class AttachmentStore {
  private readonly sessionsDir: string;

  /** A fork whose attachments are still being linked reads them from its
   *  source session meanwhile (SessionManager.attachmentsFallback). */
  private fallback: ((sessionId: string) => string | undefined) | null = null;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  setFallback(fallback: (sessionId: string) => string | undefined): void {
    this.fallback = fallback;
  }

  /** The session whose folder holds attachment `id`: the session itself, or
   *  the fork source it is still being linked from. */
  private locate(sessionId: string, id: string): string {
    if (!isSafeId(sessionId) || !isSafeId(id) || existsSync(this.metaPath(sessionId, id))) return sessionId;
    const source = this.fallback?.(sessionId);
    return source && isSafeId(source) && existsSync(this.metaPath(source, id)) ? source : sessionId;
  }

  /** Directory holding attachments for a session. */
  private dir(sessionId: string): string {
    if (!isSafeId(sessionId)) throw new Error('Invalid session id');
    return join(this.sessionsDir, sessionId, 'attachments');
  }

  private filePath(sessionId: string, id: string, ext: string): string {
    if (!isSafeId(id)) throw new Error('Invalid attachment id');
    return join(this.dir(sessionId), `${id}.${ext}`);
  }

  private metaPath(sessionId: string, id: string): string {
    if (!isSafeId(id)) throw new Error('Invalid attachment id');
    return join(this.dir(sessionId), `${id}.json`);
  }

  /**
   * Write bytes to the store (idempotent — same hash → same id, no re-write).
   *
   * Returns a `ContentRef` ready to embed in a message envelope.
   */
  put(
    sessionId: string,
    bytes: Buffer,
    mimeType: string,
    options?: { name?: string; caption?: string },
  ): ContentRef {
    const id = hashBytes(bytes);
    const ext = extForMime(mimeType);
    const dir = this.dir(sessionId);
    mkdirSync(dir, { recursive: true });

    const dataPath = this.filePath(sessionId, id, ext);
    const metaPath = this.metaPath(sessionId, id);

    let meta: AttachmentMetaSidecar | null = null;
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentMetaSidecar;
      } catch {
        meta = null;
      }
    }

    if (!existsSync(dataPath) || !meta) {
      // Atomic write of data file via tmp + rename
      const tmpData = `${dataPath}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmpData, bytes);
      renameWithRetry(tmpData, dataPath);

      const dims = readImageDimensions(bytes, mimeType);
      meta = {
        mimeType,
        size: bytes.length,
        ...(options?.name && { name: options.name }),
        ...(dims && { width: dims.width, height: dims.height }),
      };

      const tmpMeta = `${metaPath}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmpMeta, JSON.stringify(meta));
      renameWithRetry(tmpMeta, metaPath);

      logger.debug({ sessionId, id, mimeType, size: bytes.length, width: meta.width, height: meta.height }, 'stored');
    }

    return {
      type: 'content_ref',
      id,
      mimeType: meta.mimeType,
      size: meta.size,
      ...(meta.name && { name: meta.name }),
      ...(options?.caption && { caption: options.caption }),
      ...(meta.width && { width: meta.width }),
      ...(meta.height && { height: meta.height }),
    };
  }

  /** Whether an attachment id exists for the session. */
  has(sessionId: string, id: string): boolean {
    if (!isSafeId(sessionId) || !isSafeId(id)) return false;
    sessionId = this.locate(sessionId, id);
    return existsSync(this.metaPath(sessionId, id));
  }

  /** Read the full bytes + metadata. Returns null if absent. */
  read(sessionId: string, id: string): { bytes: Buffer; meta: AttachmentMetaSidecar } | null {
    if (!isSafeId(sessionId) || !isSafeId(id)) return null;
    sessionId = this.locate(sessionId, id);
    const metaPath = this.metaPath(sessionId, id);
    if (!existsSync(metaPath)) return null;
    let meta: AttachmentMetaSidecar;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentMetaSidecar;
    } catch {
      return null;
    }
    const ext = extForMime(meta.mimeType);
    const dataPath = this.filePath(sessionId, id, ext);
    if (!existsSync(dataPath)) return null;
    try {
      return { bytes: readFileSync(dataPath), meta };
    } catch {
      return null;
    }
  }

  /**
   * Read `length` bytes at `start` plus the total size, without loading the
   * whole file (paced transfers request one chunk at a time).
   */
  readRange(sessionId: string, id: string, start: number, length: number): { bytes: Buffer; size: number; meta: AttachmentMetaSidecar } | null {
    if (!isSafeId(sessionId) || !isSafeId(id)) return null;
    sessionId = this.locate(sessionId, id);
    const meta = this.readMeta(sessionId, id);
    if (!meta) return null;
    const dataPath = this.filePath(sessionId, id, extForMime(meta.mimeType));
    let fd: number | undefined;
    try {
      fd = openSync(dataPath, 'r');
      const size = fstatSync(fd).size;
      const end = Math.min(size, Math.max(0, start) + Math.max(0, length));
      const bytes = Buffer.alloc(Math.max(0, end - start));
      if (bytes.length > 0) readSync(fd, bytes, 0, bytes.length, start);
      return { bytes, size, meta };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Read the sidecar metadata only. */
  readMeta(sessionId: string, id: string): AttachmentMetaSidecar | null {
    if (!isSafeId(sessionId) || !isSafeId(id)) return null;
    sessionId = this.locate(sessionId, id);
    const metaPath = this.metaPath(sessionId, id);
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentMetaSidecar;
    } catch {
      return null;
    }
  }

  /**
   * Delete tool-call payload attachments (offloaded `<tool>.args.json` /
   * `<tool>.result.txt`) older than `maxAgeMs`, across every session. Images
   * and reports the user was shown are kept. Old Steps then show their
   * headline without the expandable body. Returns the number of payloads
   * removed.
   */
  pruneToolPayloads(maxAgeMs: number, now = Date.now()): number {
    let removed = 0;
    let sessions: string[];
    try { sessions = readdirSync(this.sessionsDir); } catch { return 0; }
    for (const sessionId of sessions) {
      if (!isSafeId(sessionId)) continue;
      const dir = join(this.sessionsDir, sessionId, 'attachments');
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const sidecar = join(dir, name);
        let meta: AttachmentMetaSidecar;
        try {
          if (now - statSync(sidecar).mtimeMs < maxAgeMs) continue;
          meta = JSON.parse(readFileSync(sidecar, 'utf8')) as AttachmentMetaSidecar;
        } catch { continue; }
        if (!meta.name || !/\.(?:args\.json|result\.txt)$/.test(meta.name)) continue;
        const id = name.slice(0, -'.json'.length);
        try { unlinkSync(join(dir, `${id}.${extForMime(meta.mimeType)}`)); } catch { /* already gone */ }
        try { unlinkSync(sidecar); removed++; } catch { /* ignore */ }
      }
    }
    if (removed > 0) logger.info({ removed, maxAgeDays: Math.round(maxAgeMs / 86_400_000) }, 'pruned old tool payload attachments');
    return removed;
  }
}
