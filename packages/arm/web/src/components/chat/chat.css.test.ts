import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = document.createElement('style');
beforeAll(() => {
  styles.textContent = readFileSync('src/components/chat/chat.css', 'utf8');
  document.head.append(styles);
});
afterAll(() => styles.remove());

function styleFor(className: string, dark: boolean): CSSStyleDeclaration {
  const root = document.createElement('div');
  root.className = dark ? 'dark' : '';
  const element = document.createElement('div');
  element.className = className;
  root.append(element);
  document.body.append(root);
  const style = getComputedStyle(element);
  root.remove();
  return style;
}

describe('chat.css — dark live-turn action colours', () => {
  it.each([
    ['kslot-lock', 'rgb(249, 115, 22)', 'rgb(255, 146, 48)'],
    ['kslot-outcome is-failed', 'rgb(239, 68, 68)', 'rgb(255, 66, 69)'],
    ['kperm-outcome is-denied', 'rgb(239, 68, 68)', 'rgb(255, 66, 69)'],
    ['kperm-outcome', 'rgb(22, 163, 74)', 'rgb(48, 209, 88)'],
    ['kstep-bad', 'rgb(255, 59, 48)', 'rgb(255, 66, 69)'],
  ])('preserves light and resolves native dark tint for %s', (className, light, dark) => {
    expect(styleFor(className, false).color).toBe(light);
    expect(styleFor(className, true).color).toBe(dark);
  });

  it('composites resolved status fills from the same native foreground', () => {
    expect(styleFor('kperm-outcome', true).backgroundColor).toBe('rgba(48, 209, 88, 0.12)');
    expect(styleFor('kperm-outcome is-denied', true).backgroundColor).toBe('rgba(255, 66, 69, 0.12)');
  });

  it('keeps compaction and Steps materials local to dark mode', () => {
    expect(styleFor('kcompacting', false).backgroundColor).toBe('rgba(232, 236, 237, 0.8)');
    expect(styleFor('kcompacting', true).backgroundColor).toBe('rgba(33, 36, 49, 0.8)');
    // jsdom does not implement backdrop-filter; paired Chromium captures
    // assert the absence of blur and the translucent label tint.
    expect(styleFor('ksteps', true).backgroundColor).toBe('rgba(255, 255, 255, 0.048)')  // transcript-D-02 calibration (shared capsule);
  });
});
