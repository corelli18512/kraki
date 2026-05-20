import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';

import type { McpToolResult } from '../protocol.js';
import type { RegisteredTool, ToolHandler } from './index.js';

/** Hard cap on a single image's raw bytes. Stays well under the relay 10 MB
 *  frame cap once base64 + JSON wrapping + RSA-OAEP per-recipient keys are
 *  added by the broadcast path. */
export const SHOW_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Allowed image MIME types, keyed by lowercase file extension. */
export const SHOW_IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const SHOW_IMAGE_TOOL_NAME = 'show_image';

const DESCRIPTION =
  'Display an image to the user in the Kraki chat. Use this when you want to ' +
  'visually present something to the user — a screenshot, diagram, chart, or ' +
  'generated graphic. For images you only need to inspect for your own ' +
  'reasoning, use the standard view/read tools instead; those appear as ' +
  'collapsible attachments rather than inline displays.';

export const showImageHandler: ToolHandler = async (args, _ctx): Promise<McpToolResult> => {
  const path = args.path;
  if (typeof path !== 'string' || path.length === 0) {
    return errorResult('Argument "path" is required and must be a non-empty string.');
  }
  if (!isAbsolute(path)) {
    return errorResult('Argument "path" must be an absolute path.');
  }

  if (!existsSync(path)) {
    return errorResult(`File not found: ${path}`);
  }

  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    return errorResult(`Could not stat file: ${(err as Error).message}`);
  }
  if (!stat.isFile()) {
    return errorResult(`Not a regular file: ${path}`);
  }
  if (stat.size > SHOW_IMAGE_MAX_BYTES) {
    return errorResult(
      `Image too large: ${stat.size} bytes (max ${SHOW_IMAGE_MAX_BYTES}). ` +
        `Resize or compress before calling show_image.`,
    );
  }

  const ext = extname(path).toLowerCase();
  const mimeType = SHOW_IMAGE_MIME_BY_EXT[ext];
  if (!mimeType) {
    return errorResult(
      `Unsupported image type "${ext || '(no extension)'}". ` +
        `Supported: ${Object.keys(SHOW_IMAGE_MIME_BY_EXT).join(', ')}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    return errorResult(`Failed to read file: ${(err as Error).message}`);
  }

  const caption = typeof args.caption === 'string' ? args.caption.trim() : '';
  const text = caption
    ? `Image displayed to user. Caption: ${caption}`
    : 'Image displayed to user.';

  return {
    content: [
      { type: 'image', mimeType, data: bytes.toString('base64') },
      { type: 'text', text },
    ],
  };
};

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export const showImageTool: RegisteredTool = {
  definition: {
    name: SHOW_IMAGE_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path to the image file on disk. Supported formats: PNG, JPEG, WebP, GIF (non-animated).',
        },
        caption: {
          type: 'string',
          description: 'Optional caption shown alongside the image.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  handler: showImageHandler,
};
