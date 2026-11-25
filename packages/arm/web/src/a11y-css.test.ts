/**
 * K-212: reduced motion stops the welcome logo reveal, its fade-ups and the
 * usage panel entrance; forced colours (Windows high contrast) keep the status
 * dots, which are drawn with a background colour the system would remove.
 * jsdom cannot evaluate these media queries; this checks the rules exist.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function mediaSelectors(file: string, condition: string): string[] {
  const style = document.createElement('style');
  // Tailwind/@import lines are not CSS jsdom can resolve; drop them.
  style.textContent = readFileSync(file, 'utf8').replace(/^@(import|custom-variant|theme|plugin)[^;{]*;/gm, '');
  document.head.append(style);
  try {
    const out: string[] = [];
    for (const rule of [...(style.sheet?.cssRules ?? [])]) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes(condition)) {
        for (const inner of [...rule.cssRules]) if (inner instanceof CSSStyleRule) out.push(inner.selectorText);
      }
    }
    return out;
  } finally { style.remove(); }
}

describe('motion and contrast preferences (K-212)', () => {
  it('reduced motion stops the welcome reveal and fade-ups', () => {
    const selectors = mediaSelectors('src/index.css', 'prefers-reduced-motion: reduce').join(' ');
    for (const name of ['.animate-logo-reveal', '.animate-fade-up', '.animate-fade-up-d2', '.animate-fade-up-d3']) expect(selectors).toContain(name);
  });
  it('reduced motion stops the usage panel entrance', () => {
    expect(mediaSelectors('src/components/usage/usage.css', 'prefers-reduced-motion: reduce').join(' ')).toContain('.ua-panel');
  });
  it('forced colours keep the status dots', () => {
    const selectors = mediaSelectors('src/index.css', 'forced-colors: active').join(' ');
    for (const name of ['.ksr-unread', '.ksr-devdot', '.ns-dot', '.rounded-full.h-2.w-2']) expect(selectors).toContain(name);
  });
});
