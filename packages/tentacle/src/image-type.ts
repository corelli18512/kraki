/** The image type a file's bytes say they are (PNG, JPEG, GIF or WebP, the
 *  types agents' models take), or null. The same rule as the pi extension's
 *  show_image (pi-kraki-tools.ts). */
export function imageMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
