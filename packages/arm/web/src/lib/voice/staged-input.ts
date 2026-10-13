import { outbox } from '../chat/outbox';
import type { StagedVoice } from './voice';

/** KrakiVoiceInputController.alignedRawPrefixLength: banded edit-distance alignment. */
export function alignedRawPrefixLength(corrected: string, raw: string): number {
  const rawCharacters = Array.from(raw);
  const normalizedRaw: string[] = [], rawIndices: number[] = [];
  rawCharacters.forEach((character, index) => {
    if (!character.trim()) return;
    for (const normalized of character.toLowerCase()) { normalizedRaw.push(normalized); rawIndices.push(index); }
  });
  const normalizedCorrected = Array.from(corrected.toLowerCase()).filter((c) => c.trim());
  if (!normalizedCorrected.length || !normalizedRaw.length) return 0;
  const n = normalizedRaw.length, band = 128, infinity = Number.MAX_SAFE_INTEGER / 4;
  let previous = Array<number>(n + 1).fill(infinity);
  for (let j = 0; j <= Math.min(n, band); j++) previous[j] = j;
  normalizedCorrected.forEach((character, index) => {
    const row = index + 1, current = Array<number>(n + 1).fill(infinity);
    if (row <= band) current[0] = row;
    for (let j = Math.max(1, row - band); j <= Math.min(n, row + band); j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(character !== normalizedRaw[j - 1]));
    }
    previous = current;
  });
  const best = Math.min(...previous);
  const offset = previous.lastIndexOf(best);
  return offset > 0 ? rawIndices[offset - 1] + 1 : 0;
}

export function mergeVoiceDraft(base: string, spoken: string): string {
  return [base.trimEnd(), spoken].filter(Boolean).join(base && !/\s$/.test(base) ? ' ' : '');
}

/** IOSVoiceComposer staged completion: failed recognition returns text to the draft,
 * but an image stays in a failed bubble; silence sends only the existing draft/image. */
export function stagedVoice(clientId: string, base: string, hasAttachment: boolean, restoreDraft: (text: string) => void): StagedVoice {
  let covered = 0;
  return {
    update(text, raw) {
      if (text === raw) { outbox.updateStaged(clientId, mergeVoiceDraft(base, raw), mergeVoiceDraft(base, raw)); return; }
      covered = Math.max(covered, alignedRawPrefixLength(text, raw));
      const rest = Array.from(raw).slice(covered).join('');
      const spoken = text + (text && rest && !/\s$/.test(text) && !/^\s/.test(rest) ? ' ' : '') + rest;
      outbox.updateStaged(clientId, mergeVoiceDraft(base, spoken), mergeVoiceDraft(base, raw));
    },
    complete(text, raw, completed) {
      if (!outbox.isStaged(clientId)) return;
      if (raw.trim() && completed) {
        outbox.dispatchStaged(clientId, mergeVoiceDraft(base, text || raw));
      } else if (!raw.trim()) {
        if (base.trim() || hasAttachment) outbox.dispatchStaged(clientId, base.trim() ? base : '[image]');
        else outbox.discard(clientId);
      } else if (hasAttachment) {
        outbox.failStaged(clientId, mergeVoiceDraft(base, raw));
      } else {
        outbox.discard(clientId);
        restoreDraft(mergeVoiceDraft(base, raw));
      }
    },
  };
}

