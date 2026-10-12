/** Attachments shared by producer and consumer messages: inline images and content refs. */

// ============================================================
// Attachment types (shared between producer and consumer)
// ============================================================

/** Inline image carried directly in a message payload as base64.
 *  Used for user_message uploads from the PWA (already capped to ~3 MB by
 *  client-side compression) and small images that don't justify the
 *  attachment-store pipeline. */
export interface ImageAttachment {
  type: 'image';
  mimeType: string;
  /** base64-encoded image bytes */
  data: string;
  /** Optional caption shown beside/under the image */
  caption?: string;
  /** Optional original filename */
  name?: string;
}

/** Reference to content stored in the tentacle's attachment store —
 *  used as a lazy handle for image bytes, large tool output, large args,
 *  etc. The ref flows inline in messages; bytes flow separately via
 *  `attachment_data` chunks. */
export interface ContentRef {
  type: 'content_ref';
  /** Content-addressed id: sha256 hex truncated to 32 chars. */
  id: string;
  mimeType: string;
  /** Decoded byte size of the underlying content. */
  size: number;
  /** Optional caption (used for image attachments). */
  caption?: string;
  /** Optional original filename, e.g. "screenshot.png". */
  name?: string;
  /** Optional intrinsic width in CSS pixels — populated when the
   *  tentacle could parse it cheaply from an image file header. */
  width?: number;
  /** Optional intrinsic height in CSS pixels. */
  height?: number;
}

export type Attachment = ImageAttachment | ContentRef;
