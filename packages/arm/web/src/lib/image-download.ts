/** Saving a chat image: the original bytes under a name with the right extension. */

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
};

/** Name used when the image has neither a file name nor a caption. */
export const DEFAULT_IMAGE_FILE_NAME = 'kraki-image';

/** The extension the image's type calls for (a GIF stays `.gif`). */
export function imageExtension(mimeType: string): string {
  const type = mimeType.toLowerCase().split(';')[0].trim();
  return IMAGE_EXTENSIONS[type] ?? (/^image\/([a-z0-9]+)$/.exec(type)?.[1] ?? 'bin');
}

/**
 * Download name for an image: its file name or caption (NFC, path and other
 * reserved characters replaced, without its old image extension, at most 80
 * characters), then the extension of its real type. Same rule as the Apple
 * clients' ChatImageFile.
 */
export function imageFileName(label: string | undefined, mimeType: string): string {
  const base = (label ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i, '')
    .trim()
    .slice(0, 80)
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return `${base || DEFAULT_IMAGE_FILE_NAME}.${imageExtension(mimeType)}`;
}

/** The bytes of an inline (base64) image attachment; null when `data` is
 *  not valid base64. */
export function base64ImageBytes(data: string): Uint8Array<ArrayBuffer> | null {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The bytes of an inline (base64) image attachment as a Blob; null when
 *  `data` is not valid base64 (there is nothing to save, but the viewer
 *  still opens). */
export function base64ImageBlob(data: string, mimeType: string): Blob | null {
  const bytes = base64ImageBytes(data);
  return bytes && new Blob([bytes], { type: mimeType });
}

/** Saves the blob as is (no re-encoding: a GIF keeps every frame). In the
 *  Windows app, Electron shows its Save dialog for the download. */
export function downloadImage(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Keep the object alive until the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
