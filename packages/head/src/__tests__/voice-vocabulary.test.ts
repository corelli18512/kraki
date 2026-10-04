import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { emptyVocabulary, mergeVocabulary, parseVocabularyUpdate, type VocabularyChange } from '../voice-vocabulary.js';
import { Storage } from '../storage.js';

const word = (term = 'Kraki', extras: Partial<VocabularyChange> = {}): VocabularyChange => ({
  id: randomUUID(), changeId: randomUUID(), baseRevision: 0, action: 'upsert', term, heardAs: '', ...extras,
});
const request = (changes: VocabularyChange[]) => ({ requestId: randomUUID(), changes });

describe('account Custom Words', () => {
  it('validates and normalizes a bounded batch, including Unicode graphemes', () => {
    expect(parseVocabularyUpdate(request([word('  Kraki ', { heardAs: 'cracky； 克拉基' })]))?.changes[0])
      .toMatchObject({ term: 'Kraki', heardAs: 'cracky, 克拉基' });
    expect(parseVocabularyUpdate(request([word('👨‍👩‍👧‍👦'.repeat(120))]))).toBeDefined();
    for (const changes of [[], [word('x'.repeat(121))], [word('#comment')], [word('a=b')], [word('a\nb')],
      [word('x', { baseRevision: -1 })], [word('x', { id: 'bad' })], [word('x', { heardAs: '\u0301'.repeat(3000) })]]) {
      expect(parseVocabularyUpdate(request(changes))).toBeUndefined();
    }
    const a = word();
    expect(parseVocabularyUpdate(request([a, a]))).toBeUndefined();
  });

  it('merges independent concurrent additions and rejects stale same-word edits', () => {
    const a = word(), b = word('Tentacle');
    const first = mergeVocabulary(emptyVocabulary(), [a]).vocabulary;
    const second = mergeVocabulary(first, [b]).vocabulary;
    expect(second.entries.map(e => e.term)).toEqual(['Kraki', 'Tentacle']);
    const edit = word('Kraki 2', { id: a.id, baseRevision: 1 });
    const edited = mergeVocabulary(second, [edit]).vocabulary;
    const conflict = mergeVocabulary(edited, [word('old', { id: a.id, baseRevision: 1 })]);
    expect(conflict.results[0].status).toBe('conflict');
    expect(conflict.vocabulary.entries[0].term).toBe('Kraki 2');
  });

  it('retries idempotently and does not resurrect a delete with an old edit/import', () => {
    const a = word('Kraki', { action: 'import' });
    const first = mergeVocabulary(emptyVocabulary(), [a]).vocabulary;
    expect(mergeVocabulary(first, [a]).vocabulary).toEqual(first);
    const deletion = word('', { id: a.id, action: 'delete', baseRevision: 1 });
    const removed = mergeVocabulary(first, [deletion]).vocabulary;
    expect(mergeVocabulary(removed, [deletion]).vocabulary).toEqual(removed);
    expect(mergeVocabulary(removed, [word('stale', { id: a.id, baseRevision: 1 })]).results[0].status).toBe('conflict');
    expect(mergeVocabulary(removed, [{ ...a, changeId: randomUUID() }]).vocabulary).toEqual(removed);
    expect(removed.entries[0]).toMatchObject({ deleted: true, term: '', heardAs: '' });
  });

  it('merges legacy aliases without renaming a word already edited on another device', () => {
    const a = word('Kraki', { action: 'import', heardAs: 'cracky' });
    const first = mergeVocabulary(emptyVocabulary(), [a]).vocabulary;
    const imported = mergeVocabulary(first, [{ ...a, changeId: randomUUID(), heardAs: '克拉基' }]).vocabulary;
    expect(imported.entries[0].heardAs).toBe('cracky, 克拉基');
    const renamed = mergeVocabulary(imported, [word('New', { id: a.id, baseRevision: 2 })]).vocabulary;
    expect(mergeVocabulary(renamed, [{ ...a, changeId: randomUUID() }]).vocabulary).toEqual(renamed);
  });

  it('reports duplicates and overflow instead of silently truncating', () => {
    const entries = Array.from({ length: 100 }, (_, i) => word(`Word ${i}`));
    const full = mergeVocabulary(emptyVocabulary(), entries).vocabulary;
    expect(mergeVocabulary(full, [word('word 0')]).results[0].status).toBe('duplicate');
    expect(mergeVocabulary(full, [word('extra')]).results[0].status).toBe('full');
    const removed = mergeVocabulary(full, [word('', { id: entries[0].id, baseRevision: 1, action: 'delete' })]).vocabulary;
    expect(mergeVocabulary(removed, [word('extra')]).results[0].status).toBe('applied');
  });

  it('scopes persistence by account and reserves the field against generic preference replacement', () => {
    const db = new Storage();
    try {
      db.upsertUser('alice', 'Alice'); db.upsertUser('bob', 'Bob');
      const first = db.updateVoiceVocabulary('alice', request([word()])).vocabulary;
      db.updatePreferences('alice', { voiceVocabulary: {}, theme: 'dark' });
      expect(db.getVoiceVocabulary('alice')).toEqual(first);
      expect(db.getUser('alice')?.preferences?.theme).toBe('dark');
      expect(db.getVoiceVocabulary('bob')).toEqual(emptyVocabulary());
    } finally { db.close(); }
  });
});
