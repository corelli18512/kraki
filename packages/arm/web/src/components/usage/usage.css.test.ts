import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const styles = document.createElement('style');
beforeAll(() => {
  styles.textContent = readFileSync('src/components/usage/usage.css', 'utf8');
  document.head.append(styles);
});
afterAll(() => styles.remove());

function rule(selector: string): CSSStyleDeclaration {
  const found = [...styles.sheet!.cssRules].reverse().find((r) =>
    r instanceof CSSStyleRule && r.selectorText.split(/,\s*/).includes(selector));
  expect(found, selector).toBeDefined();
  return (found as CSSStyleRule).style;
}

describe('usage.css — corrected dark UsagePeek environment', () => {
  it('scopes native primary/secondary ink to the dark Usage panel', () => {
    const panel = rule('.dark .ua-panel');
    expect(panel.getPropertyValue('--color-text-primary')).toBe('#e9eaeb');
    expect(panel.getPropertyValue('--color-text-secondary')).toBe('#7c7c7c');
    expect(rule('.dark .ua-chip.is-gpt').background).toBe('#e9e9eb');
    expect(rule('.ua-chip.is-gpt').background).toBe('var(--color-text-primary)');
    expect(rule('.ua-tile-plan').color).toBe('var(--color-text-secondary)');
    expect(rule('.dark .ua-card.is-hover::before').background).toBe('radial-gradient(220px circle at var(--hx) var(--hy), rgba(255, 255, 255, 0.1), transparent)');
    expect(rule('.ua-card.is-hover::before').background).toContain('transparent 70%');
  });

  it('preserves the light panel and calibrates dark panel/card/track composites', () => {
    const panels = [...styles.sheet!.cssRules].filter((r) =>
      r instanceof CSSStyleRule && r.selectorText === '.dark .ua-panel') as CSSStyleRule[];
    expect(panels[0].style.background).toBe('rgba(32, 35, 48, 0.96)');
    expect(rule('.ua-panel').background).toBe('rgba(233, 236, 238, 0.96)');
    const composite = (source: number[], alpha: number, background: number[]) =>
      source.map((v, i) => Math.round(v * alpha + background[i] * (1 - alpha)));
    const panel = composite([32, 35, 48], 0.96, [2, 6, 23]);
    expect(panel).toEqual([31, 34, 47]);
    const card = composite([233, 234, 235], 0.05, panel);
    expect(card).toEqual([41, 44, 56]);
    expect(composite([233, 234, 235], 0.09, card)).toEqual([58, 61, 72]);
  });
});
