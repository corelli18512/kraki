import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = document.createElement('style');
beforeAll(() => {
  styles.textContent = readFileSync('src/components/chat/chat.css', 'utf8');
  document.head.append(styles);
});
afterAll(() => styles.remove());

// jsdom does not render materials, masks or media queries. Check the authored
// rules here; paired Chromium screenshots verify their actual composites.
function rule(selector: string, wide = false): CSSStyleDeclaration {
  const rules = [...styles.sheet!.cssRules].flatMap((r) => {
    if (wide && r instanceof CSSMediaRule && r.conditionText === '(min-width: 768px)') return [...r.cssRules];
    return wide ? [] : [r];
  });
  const found = rules.reverse().find((r) => r instanceof CSSStyleRule && r.selectorText.split(/,\s*/).includes(selector));
  expect(found, selector).toBeDefined();
  return (found as CSSStyleRule).style;
}

function composite(source: number[], alpha: number, background: number[]): number[] {
  return source.map((v, i) => Math.round(v * alpha + background[i] * (1 - alpha)));
}

describe('chat.css — dark Mac transcript materials', () => {
  it('transmits content tint through dark header glass without changing its foreground', () => {
    const title = rule('.dark .khead.is-wide .khead-title');
    const mode = rule('.dark .khead.is-wide .khead-capsule');
    expect(title.background).toBe('rgba(30, 34, 32, 0.4)');
    // Composer-D-04 empty-canvas track/rim and transcript-D2-01 blue-content points.
    expect(mode.background).toBe('rgba(26, 28, 28, 0.6)');
    expect(mode.getPropertyValue('backdrop-filter')).toBe('blur(20px) saturate(1.65)');
    expect(title.getPropertyValue('backdrop-filter')).toBe('blur(20px) saturate(1.1)');
    expect(title.color).toBeUndefined();
    const fade = rule('.dark .khead.is-wide::before');
    expect(fade.background).toBe('rgba(13, 14, 17, 0.85)');
    expect(fade.getPropertyValue('backdrop-filter')).toBe('blur(20px) saturate(1.45)');
    expect(fade.getPropertyValue('mask-image')).toContain('rgba(0, 0, 0, 0.77) 21%');
  });

  it('adds only a dark inward blue rim and composites the disabled arrow as one SVG', () => {
    expect(rule('.dark .kprimary', true).getPropertyValue('box-shadow')).toBe('inset 0 0 0 0.5px #4dd8ef, inset 0 0 0 1px rgba(77, 212, 237, 0.6)');
    expect(rule('.dark .kprimary.is-disabled', true).color).toBe('#fff');
    expect(rule('.dark .kprimary.is-disabled svg', true).opacity).toBe('0.28');
    expect(rule('.kprimary.is-disabled', true).color).toBe('rgba(0, 0, 0, 0.25)');
    expect(rule('.dark .kprimary.is-stop', true).getPropertyValue('box-shadow')).toBe('inset 0 0 0 0.5px #d73333');
    expect(composite([255, 255, 255], 0.28, [12, 15, 28])).toEqual([80, 82, 92]);
  });

  it('composites translucent Steps fill and dots over both clear chat and a tinted bubble', () => {
    const steps = rule('.dark .ksteps');
    expect(steps.background).toBe('rgba(255, 255, 255, 0.048)');
    expect(steps.color).toBe('rgba(255, 255, 255, 0.55)');
    expect(steps.getPropertyValue('backdrop-filter')).toBe('none');
    expect(composite([255, 255, 255], 0.048, [2, 6, 23])).toEqual([14, 18, 34]);
    const lower = composite([255, 255, 255], 0.048, [79, 63, 40]);
    expect(lower).toEqual([87, 72, 50]);
    expect(composite([255, 255, 255], 0.55, lower)).toEqual([179, 173, 163]);
  });

  it('retains the session chevron tint and uses neutral history glass', () => {
    const navigation = rule('.dark .kjump .kround', true);
    expect(navigation.color).toBe('var(--k-jump-dark)');
    expect(navigation.background).toBe('rgba(27, 28, 38, 0.6)');
    expect(navigation.getPropertyValue('border-color')).toBe('rgba(110, 136, 208, 0.25)');
  });

  it('uses native neutral sheet dimming and the native quaternary tool-detail fill', () => {
    expect(rule('.dark .ksheet-backdrop', true).background).toBe('rgba(22, 23, 23, 0.6)');
    expect(composite([22, 23, 23], 0.6, [2, 6, 23])).toEqual([14, 16, 23]);
    expect(rule('.dark .ktool-detail').background).toBe('#0e1222'); // media-D-02 exact native fill
  });

  it('provides a visible dark blue keyboard focus ring on Close', () => {
    const focus = rule('.dark .ksheet-close:focus-visible', true);
    expect(focus.outline).toBe('3px solid #0e588a');
    expect(focus.getPropertyValue('outline-offset')).toBe('0');
    expect(focus.getPropertyValue('border-radius')).toBe('2px');
  });

  it('paints the half-point header separator over the header, separately from body rows', () => {
    expect(rule('.dark .ktable').getPropertyValue('--kt-hair')).toBe('rgba(255, 255, 255, 0.13)');
    expect(rule('.dark .ktable .ktable-grid th').getPropertyValue('background-image')).toContain('var(--kt-hair) 0.5px');
    expect(rule('.dark .ktable .ktable-grid tbody tr:first-child td').getPropertyValue('box-shadow')).toBe('none');
  });

  it('adds a pointer-transparent independent dark bottom fade without changing scroll geometry', () => {
    const fade = rule('.dark .kchat::after', true);
    expect(fade.height).toBe('88px');
    expect(fade.left).toBe('18px');
    expect(fade.right).toBe('18px');
    expect(fade.bottom).toBe('0');
    expect(fade.getPropertyValue('pointer-events')).toBe('none');
    expect(fade.getPropertyValue('mask-image')).toContain('0.58) 62%');
    expect(fade.getPropertyValue('z-index')).toBe('4');
  });
});
