import type { KeyboardEvent } from 'react';

/**
 * True for a key press that belongs to an open IME composition (Chinese,
 * Japanese…): its Enter/Escape picks or cancels the candidate and must not
 * save, close or submit. keyCode 229 covers Safari, which ends the
 * composition before the keydown arrives.
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
