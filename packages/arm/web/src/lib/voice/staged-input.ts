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

const CJK_RANGES = [[0x1100, 0x11ff], [0x2e80, 0x2fff], [0x3000, 0x303f], [0x3040, 0x30ff], [0x3100, 0x31ff],
  [0x3130, 0x318f], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xffef], [0x20000, 0x2fa1f]];

/** IOSVoiceComposer.needsSeparator at the web's existing append-to-draft boundary. */
function needsSeparator(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right || !left.trim() || !right.trim()) return false;
  const isCJK = (c: string) => CJK_RANGES.some(([min, max]) => c.codePointAt(0)! >= min && c.codePointAt(0)! <= max);
  return !isCJK(left) && !isCJK(right) && !'([{<“‘/-'.includes(left) && !'.,!?;:)]}>%”’/-…'.includes(right);
}

export function mergeVoiceDraft(base: string, spoken: string): string {
  return base + (needsSeparator(Array.from(base).at(-1), Array.from(spoken)[0]) ? ' ' : '') + spoken;
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
      const spoken = mergeVoiceDraft(text, rest);
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

