import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterSendsMessage, shouldAutoFocusTextInput } from './mobile-input';

const realMatch = window.matchMedia;
function device({ coarse, touchPoints }: { coarse: boolean; touchPoints: number }) {
  window.matchMedia = ((q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => touchPoints });
}
afterEach(() => { window.matchMedia = realMatch; delete (navigator as { maxTouchPoints?: number }).maxTouchPoints; });

describe('Enter-to-send policy', () => {
  it('touchscreen Windows laptop (fine primary pointer + touch points) sends on Enter', () => {
    device({ coarse: false, touchPoints: 10 });
    expect(enterSendsMessage()).toBe(true);
    // Autofocus policy is unchanged and separate.
    expect(shouldAutoFocusTextInput()).toBe(false);
  });
  it('desktop without touch sends on Enter', () => {
    device({ coarse: false, touchPoints: 0 });
    expect(enterSendsMessage()).toBe(true);
  });
  it('phone/tablet (coarse primary pointer) keeps Return as newline', () => {
    device({ coarse: true, touchPoints: 5 });
    expect(enterSendsMessage()).toBe(false);
  });
});
