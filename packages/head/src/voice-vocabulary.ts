// Account-owned Custom Words. Not E2E encrypted; never route through a tentacle.
// Per-entry optimistic concurrency prevents an offline edit resurrecting a delete.
import type { VoiceVocabularySnapshot, UpdateVoiceVocabularyMessage, VoiceVocabularyUpdatedMessage } from '@kraki/protocol';

export type VocabularySnapshot = VoiceVocabularySnapshot;
export type VocabularyEntry = VocabularySnapshot['entries'][number];
export type VocabularyChange = UpdateVoiceVocabularyMessage['changes'][number];
export type VocabularyUpdate = Pick<UpdateVoiceVocabularyMessage, 'requestId' | 'changes'>;
export type VocabularyResult = NonNullable<VoiceVocabularyUpdatedMessage['results']>[number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const length = (s: string) => [...graphemes.segment(s)].length;
const aliases = (s: string) => s.split(/[,，、;；\r\n\v\f\u0085\u2028\u2029]/u).map(s => s.trim()).filter(Boolean);
const line = (term: string, heardAs: string) => heardAs ? `${term} = ${heardAs}` : term;
const key = (s: string) => s.normalize('NFC').toLowerCase();
export const emptyVocabulary = (): VocabularySnapshot => ({ version: 1, revision: 0, entries: [] });

/** Validate the entire batch before making any changes. Bound raw bytes as well
 * as graphemes (combining sequences can otherwise bypass the prompt limit). */
export function parseVocabularyUpdate(value: unknown): VocabularyUpdate | undefined {
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || !uuid.test(obj.requestId)
    || !Array.isArray(obj.changes) || !obj.changes.length || obj.changes.length > 100) return;
  const changes: VocabularyChange[] = [];
  const seen = new Set<string>();
  for (const raw of obj.changes) {
    if (!raw || typeof raw !== 'object') return;
    const c = raw as VocabularyChange;
    if (typeof c.id !== 'string' || !uuid.test(c.id) || seen.has(c.id)
      || typeof c.changeId !== 'string' || !uuid.test(c.changeId)
      || !Number.isSafeInteger(c.baseRevision) || c.baseRevision < 0
      || !['upsert', 'delete', 'import'].includes(c.action)) return;
    seen.add(c.id);
    if (c.action === 'delete') {
      changes.push({ id: c.id, changeId: c.changeId, baseRevision: c.baseRevision, action: c.action });
      continue;
    }
    if (typeof c.term !== 'string' || typeof c.heardAs !== 'string'
      || c.term.length > 2048 || c.heardAs.length > 2048) return;
    const term = c.term.trim().normalize('NFC');
    const heardAs = aliases(c.heardAs).join(', ').normalize('NFC');
    if (!term || /[=＝\r\n\v\f\u0085\u2028\u2029]/u.test(term) || term.startsWith('#')
      || length(line(term, heardAs)) > 120) return;
    changes.push({ id: c.id, changeId: c.changeId, baseRevision: c.baseRevision, action: c.action, term, heardAs });
  }
  return { requestId: obj.requestId, changes };
}

export function mergeVocabulary(current: VocabularySnapshot, changes: VocabularyChange[]): {
  vocabulary: VocabularySnapshot; results: VocabularyResult[];
} {
  const vocabulary = structuredClone(current);
  const results: VocabularyResult[] = [];
  for (const c of changes) {
    const existing = vocabulary.entries.find(e => e.id === c.id);
    const finish = (status: VocabularyResult['status']) => results.push({ changeId: c.changeId, status });
    if (existing?.changeId === c.changeId) { finish('applied'); continue; }
    // Import once per installation. A legacy copy must not undo a deletion or
    // rename made by an already-migrated device. Same word: union mishearings.
    if (c.action === 'import') {
      if (existing && (existing.deleted || key(existing.term) !== key(c.term!))) {
        finish('applied'); continue;
      }
      const same = existing ?? vocabulary.entries.find(e => !e.deleted && key(e.term) === key(c.term!));
      if (same) {
        const merged = [...new Set([...aliases(same.heardAs), ...aliases(c.heardAs!)])].join(', ');
        if (length(line(same.term, merged)) > 120) { finish('full'); continue; }
        if (same.heardAs !== merged) {
          same.heardAs = merged;
          same.revision = ++vocabulary.revision;
          same.changeId = c.changeId;
        }
        finish('applied'); continue;
      }
    } else if ((existing?.revision ?? 0) !== c.baseRevision) {
      finish('conflict'); continue;
    }
    const deleted = c.action === 'delete';
    if (!deleted && vocabulary.entries.some(e => !e.deleted && e.id !== c.id && key(e.term) === key(c.term!))) {
      finish('duplicate'); continue;
    }
    // Tombstones are never evicted: old clients can remain offline indefinitely.
    // Bound storage instead of silently discarding deletion history.
    if ((!existing && vocabulary.entries.length >= 2000)
      || (!deleted && (!existing || existing.deleted) && vocabulary.entries.filter(e => !e.deleted).length >= 100)) {
      finish('full'); continue;
    }
    const entry: VocabularyEntry = {
      id: c.id, revision: ++vocabulary.revision, changeId: c.changeId, deleted,
      term: deleted ? '' : c.term!, heardAs: deleted ? '' : c.heardAs!,
    };
    if (existing) Object.assign(existing, entry); else vocabulary.entries.push(entry);
    finish('applied');
  }
  return { vocabulary, results };
}
