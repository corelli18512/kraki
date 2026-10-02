// ------------------------------------------------------------
// Push preview text — Markdown reply → plain notification body
// ------------------------------------------------------------

import { toWellFormedText } from './session-manager.js';

/** Byte budget for the encrypted preview summary. APNs caps the whole payload
 *  at 4096 bytes; one RSA-4096 wrapped key plus envelope costs ~1.1 KB and the
 *  encrypted blob is base64 (4/3). 1500 UTF-8 bytes (~500 CJK / ~1500 Latin
 *  characters) leaves headroom for the Session title and JSON escaping. */
export const PUSH_SUMMARY_MAX_BYTES = 1500;

/** Turn Markdown into a single run of readable text for a notification body:
 *  headings, emphasis, inline code, fences, links, images, list markers,
 *  blockquotes and table rules are reduced to their words. */
export function markdownToPlainText(markdown: string): string {
  let text = toWellFormedText(markdown).replace(/\r\n?/g, '\n');
  text = text
    // fenced code: keep the code, drop the fence lines
    .replace(/^[ \t]*(```|~~~).*$/gm, '')
    // images then links → their text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // table separator rows, then cell pipes
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) => row.split('|').map((c) => c.trim()).filter(Boolean).join('  '))
    // block prefixes
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    // inline emphasis and code
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes on a code-point boundary,
 *  ending with an ellipsis when anything was dropped. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength('…', 'utf8');
  let used = 0;
  let out = '';
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > budget) break;
    used += size;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}
