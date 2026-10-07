// Account-owned Custom Words. Not E2E encrypted; never routed through a tentacle.
//
// Clients send user intents (add / edit / remove one word), never whole lists,
// so a stale device cannot overwrite newer words. Head applies intents in
// arrival order; the last one wins and nothing is surfaced to the user.
// `applyVoiceWordOps` is mirrored by the native client for its optimistic view
// (VoiceVocabularySync.swift); keep the two in step.
import type { VoiceWord, VoiceWordOp } from '@kraki/protocol';

export type { VoiceWord, VoiceWordOp };

export const MAX_VOICE_WORDS = 100;
const MAX_LINE = 120;
const MAX_OPS = 200;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const length = (s: string) => [...graphemes.segment(s)].length;
const aliases = (s: string) =>
  s.split(/[,，、;；\r\n\v\f\u0085\u2028\u2029]/u).map(a => a.trim()).filter(Boolean);
const line = (w: VoiceWord) => (w.heardAs ? `${w.term} = ${w.heardAs}` : w.term);
/** Words are identified by spelling, case-insensitively. */
export const wordKey = (term: string) => term.trim().normalize('NFC').toLowerCase();

function cleanWord(term: unknown, heardAs: unknown): VoiceWord | undefined {
  if (typeof term !== 'string' || term.length > 2048) return;
  if (heardAs !== undefined && (typeof heardAs !== 'string' || heardAs.length > 2048)) return;
  const word = {
    term: term.trim().normalize('NFC'),
    heardAs: aliases((heardAs as string | undefined) ?? '').join(', ').normalize('NFC'),
  };
  if (!word.term || /[=＝\r\n\v\f\u0085\u2028\u2029]/u.test(word.term) || word.term.startsWith('#')
    || length(line(word)) > MAX_LINE) return;
  return word;
}

/** Validates each op; invalid ones are dropped so one bad entry cannot block
 *  the rest of a device's queue. Undefined only if `value` is not an op list. */
export function parseVoiceWordOps(value: unknown): VoiceWordOp[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OPS) return;
  const ops: VoiceWordOp[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (o.op === 'remove') {
      if (typeof o.term === 'string' && o.term.trim() && o.term.length <= 2048) ops.push({ op: 'remove', term: o.term });
      continue;
    }
    if (o.op !== 'add' && o.op !== 'edit') continue;
    const word = cleanWord(o.term, o.heardAs);
    if (!word) continue;
    if (o.op === 'edit') {
      if (typeof o.from !== 'string' || o.from.length > 2048) continue;
      ops.push({ op: 'edit', from: o.from, ...word });
    } else {
      ops.push({ op: 'add', ...word });
    }
  }
  return ops;
}

/** Adding a word that already exists merges its mishearings (two devices
 *  adding the same word). Editing replaces it; an edit of a word another
 *  device removed adds it back (the later intent wins). */
export function applyVoiceWordOps(current: VoiceWord[], ops: VoiceWordOp[]): VoiceWord[] {
  const words = current.map(w => ({ ...w }));
  const find = (term: string) => words.findIndex(w => wordKey(w.term) === wordKey(term));
  const merge = (i: number, heardAs: string) => {
    const merged = { ...words[i], heardAs: [...new Set([...aliases(words[i].heardAs), ...aliases(heardAs)])].join(', ') };
    if (length(line(merged)) <= MAX_LINE) words[i] = merged;
  };
  for (const op of ops) {
    if (op.op === 'remove') {
      const i = find(op.term);
      if (i >= 0) words.splice(i, 1);
      continue;
    }
    const word = { term: op.term, heardAs: op.heardAs ?? '' };
    let at = -1;
    if (op.op === 'edit') {
      at = find(op.from ?? '');
      if (at >= 0 && wordKey(op.from ?? '') === wordKey(word.term)) { words[at] = word; continue; }
      if (at >= 0) words.splice(at, 1);
    }
    const existing = find(word.term);
    // Renamed onto another existing word: fold into it rather than duplicate.
    if (existing >= 0) {
      merge(existing, word.heardAs);
    } else if (words.length < MAX_VOICE_WORDS) {
      words.splice(at >= 0 ? at : words.length, 0, word);
    }
  }
  return words;
}

/** Stored as `users.preferences.voiceVocabulary = { version: 2, words }`. */
export function storedVoiceWords(value: unknown): VoiceWord[] {
  const v = value as { version?: unknown; words?: unknown } | undefined;
  if (v?.version !== 2 || !Array.isArray(v.words)) return [];
  return v.words.filter((w): w is VoiceWord =>
    !!w && typeof (w as VoiceWord).term === 'string' && typeof (w as VoiceWord).heardAs === 'string');
}
