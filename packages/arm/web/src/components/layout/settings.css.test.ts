import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function rule(path: string, selector: string): CSSStyleDeclaration {
  const style = document.createElement('style');
  style.textContent = readFileSync(path, 'utf8');
  document.head.append(style);
  try {
    const found = [...style.sheet!.cssRules].reverse().find((r) =>
      r instanceof CSSStyleRule && r.selectorText.split(/,\s*/).includes(selector));
    expect(found, selector).toBeDefined();
    return (found as CSSStyleRule).style;
  } finally {
    style.remove();
  }
}

describe('settings.css — dark native focus placement', () => {
  it('moves only the dark recorder outline inward by the remaining point', () => {
    const path = 'src/components/layout/settings.css';
    expect(rule(path, '.dark .kp-button.is-recording').getPropertyValue('outline-offset')).toBe('1px');
    expect(rule(path, '.dark .kp-button.is-recording').outline).toBe('3px solid #226d97');
    // Light recorder has no authored outline override.
    expect(readFileSync(path, 'utf8')).not.toMatch(/(?:^|\n)\.kp-button\.is-recording\s*\{/);
  });

  it('joins the dark default-action ring to its edge without altering light focus', () => {
    const path = 'src/components/desktop/desktop-setup.css';
    const dark = rule(path, '.dark .ds-sheet .ds-button-default:focus-visible');
    expect(dark.getPropertyValue('outline-offset')).toBe('0');
    expect(dark.getPropertyValue('outline-color')).toBe('#1f6a94');
    expect(rule(path, '.ds-sheet .ds-button:focus-visible').getPropertyValue('outline-offset')).toBe('2px');
  });
});

describe('settings.css — long translations (K-233)', () => {
  it('lets the Theme control grow and wrap instead of overflowing its row', () => {
    const path = 'src/components/layout/settings.css';
    const segment = rule(path, '.kp-segment');
    expect(segment.getPropertyValue('width')).toBe('');
    expect(segment.getPropertyValue('min-width')).toBe('195px');
    expect(segment.getPropertyValue('max-width')).toBe('100%');
    expect(rule(path, '.kp-segment button').getPropertyValue('overflow-wrap')).toBe('anywhere');
  });
});
