import { describe, it, expect } from 'vitest';
import { markdownToPlainText, sliceGraphemes, truncateUtf8, PUSH_SUMMARY_MAX_BYTES } from '../push-preview-text.js';

describe('markdownToPlainText', () => {
  it('reduces common Markdown to its words on one line', () => {
    const md = [
      '## Fixed',
      '',
      'The push **no longer** reuses the `previous` reply. See [PR #385](https://github.com/x/y/pull/385).',
      '',
      '- first item',
      '* second item',
      '> quoted',
      '',
      '| Test | Result |',
      '|---|:---:|',
      '| tentacle | 1204 passed |',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '![chart](a.png) _done_ ~~old~~',
    ].join('\n');
    expect(markdownToPlainText(md)).toBe(
      'Fixed The push no longer reuses the previous reply. See PR #385. first item second item quoted Test Result tentacle 1204 passed const a = 1; chart done old',
    );
  });

  it('leaves snake_case, file paths and arithmetic alone', () => {
    expect(markdownToPlainText('Edit src/push_preview_text.ts so 2 * 3 * 4 holds')).toBe('Edit src/push_preview_text.ts so 2 * 3 * 4 holds');
  });

  it('keeps Chinese text intact', () => {
    expect(markdownToPlainText('**已修复**，提了 PR #385。\n\n下一步：发版。')).toBe('已修复，提了 PR #385。 下一步：发版。');
  });
});

describe('truncateUtf8', () => {
  it('returns short text unchanged', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello');
  });

  it('cuts on a code-point boundary within the byte budget and adds an ellipsis', () => {
    const out = truncateUtf8('好'.repeat(1000), PUSH_SUMMARY_MAX_BYTES);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(PUSH_SUMMARY_MAX_BYTES);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1)).toBe('好'.repeat(Array.from(out).length - 1));
  });

  it('K-216: never splits a ZWJ or flag emoji sequence', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(truncateUtf8(`ab${family}cd`, 2 + 10 + 3)).toBe('ab…');
    const flags = '\u{1F1EF}\u{1F1F5}'.repeat(5);
    expect(truncateUtf8(flags, 8 + 4 + 3)).toBe('\u{1F1EF}\u{1F1F5}…');
  });

  it('never splits an emoji surrogate pair', () => {
    const out = truncateUtf8('😀'.repeat(10), 9);
    expect(out).toBe('😀…');
  });
});

describe('sliceGraphemes (push title)', () => {
  it('K-216: cuts the title by grapheme, never inside a ZWJ or flag sequence', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const title = `${'a'.repeat(79)}${family}${family}`;
    // Code-point slicing (the old cut) leaves a dangling ZWJ fragment.
    expect(Array.from(title).slice(0, 80).join('')).not.toBe(`${'a'.repeat(79)}${family}`);
    expect(sliceGraphemes(title, 80)).toBe(`${'a'.repeat(79)}${family}`);
    const flag = '\u{1F1EF}\u{1F1F5}';
    expect(sliceGraphemes(`${'b'.repeat(79)}${flag}${flag}`, 80)).toBe(`${'b'.repeat(79)}${flag}`);
    expect(sliceGraphemes('short', 80)).toBe('short');
  });
});
