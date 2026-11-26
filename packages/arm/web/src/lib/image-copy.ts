/**
 * Copy Image for chat images (web and the Windows app).
 *
 * Browsers' asynchronous clipboard takes images as PNG only, so the image is
 * copied as a PNG: as is when it is one, else drawn once into a canvas — a
 * GIF copies its first frame (Download Image keeps every frame). Rejects
 * when the browser has no image clipboard (a plain-http page, an older
 * Firefox) or refuses the write, so the caller can say so.
 *
 * Call it synchronously in the click: Safari only lets the click itself
 * start a clipboard write, so the PNG is handed over as a promise.
 */
export function copyImage(blob: Blob): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (typeof clipboard?.write !== 'function' || typeof ClipboardItem === 'undefined') {
    return Promise.reject(new Error('Image clipboard unavailable'));
  }
  const png = blob.type === 'image/png' ? Promise.resolve(blob) : firstFramePng(blob);
  // An unhandled rejection of `png` is reported by `write`.
  png.catch(() => {});
  try {
    return clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (err) {
    return Promise.reject(err);
  }
}

/** The image (a GIF's first frame: drawing an animated image draws that
 *  one) re-encoded as PNG. */
export async function firstFramePng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) throw new Error('Image cannot be drawn');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('PNG encoding failed'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
