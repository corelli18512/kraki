import { describe, it, expect } from 'vitest';
import { applyVoiceWordOps, parseVoiceWordOps, storedVoiceWords, MAX_VOICE_WORDS, type VoiceWord } from '../voice-vocabulary.js';
import { Storage } from '../storage.js';

const apply = (words: VoiceWord[], ops: unknown[]) => applyVoiceWordOps(words, parseVoiceWordOps(ops)!);
const w = (term: string, heardAs = ''): VoiceWord => ({ term, heardAs });

describe('Custom Words intents', () => {
  it('normalizes input and drops invalid ops without rejecting the rest', () => {
    const ops = parseVoiceWordOps([
      { op: 'add', term: '  Kraki ', heardAs: 'cracky； 克拉奇' },
      { op: 'add', term: 'a=b' }, { op: 'add', term: '#x' }, { op: 'add', term: 'x'.repeat(121) },
      { op: 'add', term: 'a\nb' }, { op: 'edit', term: 'no from' }, { op: 'bogus', term: 'x' }, null,
      { op: 'remove', term: 'Old' },
    ]);
    expect(ops).toEqual([{ op: 'add', term: 'Kraki', heardAs: 'cracky, 克拉奇' }, { op: 'remove', term: 'Old' }]);
    expect(parseVoiceWordOps('nope')).toBeUndefined();
    expect(parseVoiceWordOps(new Array(201).fill({ op: 'remove', term: 'x' }))).toBeUndefined();
    expect(parseVoiceWordOps([{ op: 'add', term: '👨‍👩‍👧‍👦'.repeat(120) }])).toHaveLength(1);
  });

  it('two devices adding the same word merge into one entry', () => {
    const words = apply([w('Kraki', 'cracky')], [{ op: 'add', term: 'KRAKI', heardAs: '克拉奇, cracky' }]);
    expect(words).toEqual([w('Kraki', 'cracky, 克拉奇')]);
  });

  it('edits replace in place, the later edit wins, and replays are harmless', () => {
    const first = apply([w('A'), w('Kraki', 'cracky'), w('B')], [{ op: 'edit', from: 'Kraki', term: 'Kraki App', heardAs: 'x' }]);
    expect(first).toEqual([w('A'), w('Kraki App', 'x'), w('B')]);
    const later = apply(first, [{ op: 'edit', from: 'kraki app', term: 'Kraki App', heardAs: 'y' }]);
    expect(later).toEqual([w('A'), w('Kraki App', 'y'), w('B')]);
    expect(apply(later, [{ op: 'edit', from: 'Kraki App', term: 'Kraki App', heardAs: 'y' }])).toEqual(later);
  });

  it('an edit of a word another device removed adds it back; removing twice is harmless', () => {
    const removed = apply([w('Kraki')], [{ op: 'remove', term: 'kraki' }, { op: 'remove', term: 'Kraki' }]);
    expect(removed).toEqual([]);
    expect(apply(removed, [{ op: 'edit', from: 'Kraki', term: 'Kraki', heardAs: 'cracky' }])).toEqual([w('Kraki', 'cracky')]);
  });

  it('renaming onto an existing word folds into it instead of duplicating', () => {
    expect(apply([w('A', 'a'), w('B', 'b')], [{ op: 'edit', from: 'A', term: 'b', heardAs: 'a' }])).toEqual([w('B', 'b, a')]);
  });

  it('stops at the word limit without failing the request', () => {
    const full = Array.from({ length: MAX_VOICE_WORDS }, (_, i) => w(`W${i}`));
    expect(apply(full, [{ op: 'add', term: 'extra' }])).toHaveLength(MAX_VOICE_WORDS);
    expect(apply(full, [{ op: 'remove', term: 'W0' }, { op: 'add', term: 'extra' }]).at(-1)).toEqual(w('extra'));
  });

  it('persists per account and is protected from generic preference writes', () => {
    const db = new Storage();
    try {
      db.upsertUser('alice', 'Alice'); db.upsertUser('bob', 'Bob');
      expect(db.updateVoiceVocabulary('alice', [{ op: 'add', term: 'Kraki', heardAs: '' }])).toEqual([w('Kraki')]);
      db.updatePreferences('alice', { voiceVocabulary: { version: 2, words: [] }, theme: 'dark' });
      expect(db.getVoiceVocabulary('alice')).toEqual([w('Kraki')]);
      expect(db.getUser('alice')?.preferences?.theme).toBe('dark');
      expect(db.getVoiceVocabulary('bob')).toEqual([]);
      expect(storedVoiceWords({ version: 1, entries: [] })).toEqual([]);
    } finally { db.close(); }
  });
});
