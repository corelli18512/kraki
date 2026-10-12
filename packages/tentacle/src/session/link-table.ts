/** Links between local agent sessions (e.g. Copilot CLI) and Kraki sessions. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../fs-retry.js';
import type { SessionLink } from './types.js';

export class SessionLinkTable {
  constructor(private readonly sessionsDir: string) {}

  private get linkTablePath(): string {
    return join(this.sessionsDir, 'link-table.json');
  }

  private readLinkTable(): SessionLink[] {
    try {
      return JSON.parse(readFileSync(this.linkTablePath, 'utf8'));
    } catch { return []; }
  }

  private writeLinkTable(links: SessionLink[]): void {
    atomicWrite(this.linkTablePath, JSON.stringify(links, null, 2));
  }

  /** Add a link between a local Copilot session and a Kraki session. */
  addLink(link: SessionLink): void {
    const links = this.readLinkTable();
    // Replace existing link for this local session ID
    const idx = links.findIndex(l => l.localSessionId === link.localSessionId);
    if (idx >= 0) links[idx] = link;
    else links.push(link);
    this.writeLinkTable(links);
  }

  /** Remove a link by local session ID. */
  removeLink(localSessionId: string): void {
    const links = this.readLinkTable().filter(l => l.localSessionId !== localSessionId);
    this.writeLinkTable(links);
  }

  /** Remove a link by Kraki session ID (used on session delete). */
  removeLinkByKrakiId(krakiSessionId: string): void {
    const links = this.readLinkTable().filter(l => l.krakiSessionId !== krakiSessionId);
    this.writeLinkTable(links);
  }

  /** Get link for a local session ID. */
  getLink(localSessionId: string): SessionLink | null {
    return this.readLinkTable().find(l => l.localSessionId === localSessionId) ?? null;
  }

  /** Get all linked local session IDs. */
  getLinkedIds(): Set<string> {
    return new Set(this.readLinkTable().map(l => l.localSessionId));
  }

  /** Get all links. */
  getAllLinks(): SessionLink[] {
    return this.readLinkTable();
  }
}

/** Atomic write: write to temp file, then rename (prevents corruption on crash). */
function atomicWrite(path: string, data: string): void {
  atomicWriteFile(path, data);
}
