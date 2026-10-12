/** Restart-safe identity of every send_input (see InputLedgerEntry). */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../fs-retry.js';
import type { InputLedgerEntry, LoggedMessage } from './types.js';

export class InputLedgerStore {
  static readonly INPUT_LEDGER_TERMINAL_LIMIT = 2048;

  readonly inputLedgerCache = new Map<string, InputLedgerEntry[]>();
  /** Uncompacted clientId index. The bounded ledger remains the hot state
   * machine, while this metadata-only log preserves replay deduplication for
   * older terminal inputs without rescanning messages.jsonl. */
  private inputClientIndexCache = new Map<string, Map<string, InputLedgerEntry>>();

  constructor(private readonly sessionDir: (sessionId: string) => string) {}

  private inputLedgerPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'input-ledger.json');
  }

  private inputClientIndexPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'input-client-index.jsonl');
  }

  private loadInputClientIndex(sessionId: string): Map<string, InputLedgerEntry> {
    const existing = this.inputClientIndexCache.get(sessionId);
    if (existing) return existing;
    const index = new Map<string, InputLedgerEntry>();
    const path = this.inputClientIndexPath(sessionId);
    if (existsSync(path)) {
      try {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as InputLedgerEntry;
            if (entry?.version === 1 && typeof entry.clientId === 'string' && typeof entry.contentHash === 'string') {
              index.set(entry.clientId, entry);
            }
          } catch {
            // Ignore a truncated final index row after an interrupted write.
          }
        }
      } catch {
        // The bounded ledger remains the fallback if the index is unavailable.
      }
    }
    this.inputClientIndexCache.set(sessionId, index);
    return index;
  }

  private persistInputClientIndex(sessionId: string, entry: InputLedgerEntry): void {
    const index = this.loadInputClientIndex(sessionId);
    index.set(entry.clientId, { ...entry });
    appendFileSync(this.inputClientIndexPath(sessionId), `${JSON.stringify(entry)}\n`);
  }

  private loadInputLedger(sessionId: string): InputLedgerEntry[] {
    const path = this.inputLedgerPath(sessionId);
    if (!existsSync(path)) return [];
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter((entry): entry is InputLedgerEntry =>
        !!entry && typeof entry === 'object'
        && (entry as InputLedgerEntry).version === 1
        && typeof (entry as InputLedgerEntry).clientId === 'string'
        && typeof (entry as InputLedgerEntry).contentHash === 'string',
      );
    } catch {
      return [];
    }
  }

  getInputLedger(sessionId: string): InputLedgerEntry[] {
    if (!this.inputLedgerCache.has(sessionId)) {
      const entries = this.loadInputLedger(sessionId);
      this.inputLedgerCache.set(sessionId, entries);
      const index = this.loadInputClientIndex(sessionId);
      // Seed indexes created before this file existed, including entries that
      // will be compacted by the first subsequent ledger transition.
      for (const entry of entries) index.set(entry.clientId, { ...entry });
    }
    return this.inputLedgerCache.get(sessionId)!.map((entry) => ({ ...entry }));
  }

  getInputLedgerEntry(sessionId: string, clientId: string): InputLedgerEntry | null {
    const current = this.getInputLedger(sessionId).find((entry) => entry.clientId === clientId);
    if (current) return current;
    const indexed = this.loadInputClientIndex(sessionId).get(clientId);
    return indexed ? { ...indexed } : null;
  }

  private compactInputLedger(entries: InputLedgerEntry[]): InputLedgerEntry[] {
    const isOpen = (entry: InputLedgerEntry) =>
      entry.status === 'pending' || entry.status === 'persisted' || entry.status === 'dispatching';
    const retainedTerminalIds = new Set(
      entries.filter((entry) => !isOpen(entry))
        .slice(-InputLedgerStore.INPUT_LEDGER_TERMINAL_LIMIT)
        .map((entry) => entry.clientId),
    );
    return entries.filter((entry) => isOpen(entry) || retainedTerminalIds.has(entry.clientId));
  }

  recordInputLedger(sessionId: string, entry: InputLedgerEntry): void {
    const path = this.inputLedgerPath(sessionId);
    const entries = (this.inputLedgerCache.get(sessionId) ?? this.loadInputLedger(sessionId))
      .filter((item) => item.clientId !== entry.clientId);
    const indexPath = this.inputClientIndexPath(sessionId);
    const index = this.loadInputClientIndex(sessionId);
    const indexWasMissing = !existsSync(indexPath);
    for (const existing of entries) index.set(existing.clientId, { ...existing });
    if (indexWasMissing && entries.length > 0) {
      appendFileSync(indexPath, `${entries.map((existing) => JSON.stringify(existing)).join('\n')}\n`);
    }
    entries.push({ ...entry });
    const compacted = this.compactInputLedger(entries);
    this.inputLedgerCache.set(sessionId, compacted);
    atomicWrite(path, JSON.stringify(compacted, null, 2));
    this.persistInputClientIndex(sessionId, entry);
  }

  findUserMessageSeqByClientId(sessionId: string, clientId: string): number | null {
    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    if (!existsSync(logPath)) return null;
    try {
      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as LoggedMessage;
          if (entry.type !== 'user_message') continue;
          const payload = JSON.parse(entry.payload) as { payload?: { clientId?: string } };
          if (payload.payload?.clientId === clientId) return entry.seq;
        } catch {
          // Ignore an unrelated malformed line while recovering the ledger.
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  markInputLedgerSettled(sessionId: string, turnId: string): void {
    const entries = this.getInputLedger(sessionId);
    let changed = false;
    const changedEntries: InputLedgerEntry[] = [];
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (entry.turnId !== turnId || (entry.status !== 'persisted' && entry.status !== 'dispatching' && entry.status !== 'delivered')) continue;
      entry.status = 'settled';
      entry.updatedAt = now;
      changed = true;
      changedEntries.push(entry);
    }
    if (changed) {
      const compacted = this.compactInputLedger(entries);
      this.inputLedgerCache.set(sessionId, compacted);
      atomicWrite(this.inputLedgerPath(sessionId), JSON.stringify(compacted, null, 2));
      for (const entry of changedEntries) this.persistInputClientIndex(sessionId, entry);
    }
  }
}

/** Atomic write: write to temp file, then rename (prevents corruption on crash). */
function atomicWrite(path: string, data: string): void {
  atomicWriteFile(path, data);
}
