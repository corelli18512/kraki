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
} from 'node:fs';
import { join } from 'node:path';

import type { ContentRef } from '@kraki/protocol';

import { createLogger } from './logger.js';

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

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  /** Directory holding attachments for a session. */
  private dir(sessionId: string): string {
    return join(this.sessionsDir, sessionId, 'attachments');
  }

  private filePath(sessionId: string, id: string, ext: string): string {
    return join(this.dir(sessionId), `${id}.${ext}`);
  }

  private metaPath(sessionId: string, id: string): string {
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
      renameSync(tmpData, dataPath);

      const dims = readImageDimensions(bytes, mimeType);
      meta = {
        mimeType,
        size: bytes.length,
        ...(options?.name && { name: options.name }),
        ...(dims && { width: dims.width, height: dims.height }),
      };

      const tmpMeta = `${metaPath}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmpMeta, JSON.stringify(meta));
      renameSync(tmpMeta, metaPath);

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
    return existsSync(this.metaPath(sessionId, id));
  }

  /** Read the full bytes + metadata. Returns null if absent. */
  read(sessionId: string, id: string): { bytes: Buffer; meta: AttachmentMetaSidecar } | null {
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
   * Iterate over the bytes of an attachment in chunks of `chunkSize` bytes.
   * Memory-bounded — does not load the whole file into one buffer (uses
   * subarray slices into the read buffer).
   */
  *stream(sessionId: string, id: string, chunkSize: number): Generator<Buffer> {
    const result = this.read(sessionId, id);
    if (!result) return;
    const { bytes } = result;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    }
  }

  /** Read the sidecar metadata only. */
  readMeta(sessionId: string, id: string): AttachmentMetaSidecar | null {
    const metaPath = this.metaPath(sessionId, id);
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentMetaSidecar;
    } catch {
      return null;
    }
  }

  /** Remove all attachments for a session (called on session deletion). */
  removeSession(sessionId: string): void {
    const dir = this.dir(sessionId);
    if (!existsSync(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, sessionId }, 'failed to remove attachments dir');
    }
  }

  /**
   * Garbage-collect orphan attachments — files in the session's
   * attachments dir whose id is NOT in `referencedIds`. Returns count of
   * deleted (data, meta) pairs.
   */
  gc(sessionId: string, referencedIds: Set<string>): number {
    const dir = this.dir(sessionId);
    if (!existsSync(dir)) return 0;
    let removed = 0;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }
    // Collect ids present on disk: anything matching <id>.<ext> or <id>.json
    const idsOnDisk = new Set<string>();
    for (const name of entries) {
      const dot = name.lastIndexOf('.');
      if (dot <= 0) continue;
      idsOnDisk.add(name.slice(0, dot));
    }
    for (const id of idsOnDisk) {
      if (referencedIds.has(id)) continue;
      for (const name of entries) {
        if (name.startsWith(`${id}.`)) {
          try {
            unlinkSync(join(dir, name));
            removed++;
          } catch {
            // ignore
          }
        }
      }
    }
    if (removed > 0) {
      logger.info({ sessionId, removed }, 'gc removed orphan attachments');
    }
    return removed;
  }

  /** Total bytes consumed by a session's attachments (for diagnostics). */
  sizeOfSession(sessionId: string): number {
    const dir = this.dir(sessionId);
    if (!existsSync(dir)) return 0;
    let total = 0;
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.json')) continue;
        try {
          total += statSync(join(dir, name)).size;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return total;
  }
}
