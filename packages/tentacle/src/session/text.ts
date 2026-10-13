/** Text and id rules shared by everything that reads or writes sessions. */

/** Ids from the wire become path segments under ~/.kraki/sessions. Only
 *  allow the characters our own ids use, so `..` or a slash can never reach
 *  the filesystem (e.g. delete_session with id `..` removing ~/.kraki). */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200
    && /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/** Replace lone UTF-16 surrogates before serializing text for strict JSON consumers. */
export function toWellFormedText(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text[i] + text[++i];
      } else {
        result += '\ufffd';
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      result += '\ufffd';
    } else {
      result += text[i];
    }
  }
  return result;
}
