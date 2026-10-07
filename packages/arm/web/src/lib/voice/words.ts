/**
 * Custom Words, owned by the account and synced through the relay
 * (`update_voice_vocabulary` intents, `voice_vocabulary_updated` lists) —
 * a mirror of Head's applyVoiceWordOps (packages/head/src/voice-vocabulary.ts)
 * for the optimistic local view, as on Mac/iOS (VoiceWordList).
 */
import type { VoiceWord, VoiceWordOp } from '@kraki/protocol';

export const MAX_WORDS = 100;
export const MAX_LINE = 120;

export const wordKey = (term: string) => term.trim().normalize('NFC').toLowerCase();

/** "Term = heard 1, heard 2" (or just "Term"), as sent to the corrector. */
export const wordLine = (w: VoiceWord) => (w.heardAs ? `${w.term} = ${w.heardAs}` : w.term);

export const aliases = (s: string) =>
  s.split(/[,，、;；\r\n\v\f\u0085\u2028\u2029]/u).map((a) => a.trim()).filter(Boolean);

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const length = (s: string) => [...graphemes.segment(s)].length;

/** Head's cleanWord: the word as Head will store it, or null when Head drops it. */
export function cleanWord(term: string, heardAs = ''): VoiceWord | null {
  const word = { term: term.trim().normalize('NFC'), heardAs: aliases(heardAs).join(', ').normalize('NFC') };
  if (!word.term || /[=＝\r\n\v\f\u0085\u2028\u2029]/u.test(word.term) || word.term.startsWith('#') || length(wordLine(word)) > MAX_LINE) return null;
  return word;
}

export function applyOps(ops: VoiceWordOp[], current: VoiceWord[], max = MAX_WORDS): VoiceWord[] {
  const words = current.map((w) => ({ ...w }));
  const find = (term: string) => words.findIndex((w) => wordKey(w.term) === wordKey(term));
  const merge = (i: number, heardAs: string) => {
    const candidate = { ...words[i], heardAs: [...new Set([...aliases(words[i].heardAs), ...aliases(heardAs)])].join(', ') };
    if (length(wordLine(candidate)) <= MAX_LINE) words[i] = candidate;
  };
  for (const op of ops) {
    if (op.op === 'remove') { const i = find(op.term); if (i >= 0) words.splice(i, 1); continue; }
    const word = { term: op.term, heardAs: op.heardAs ?? '' };
    let at = -1;
    if (op.op === 'edit') {
      at = find(op.from ?? '');
      if (at >= 0 && wordKey(op.from ?? '') === wordKey(word.term)) { words[at] = word; continue; }
      if (at >= 0) words.splice(at, 1);
    }
    const existing = find(word.term);
    if (existing >= 0) merge(existing, word.heardAs);
    else if (words.length < max) words.splice(at >= 0 ? at : words.length, 0, word);
  }
  return words;
}
