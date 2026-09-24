import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Pi RPC uses LF-only JSONL. Node readline also recognizes Unicode separators
 * inside valid JSON strings. Decode split UTF-8 chunks without losing bytes. */
export function readPiJsonLines(input: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let closed = false;
  const drain = () => {
    while (!closed) {
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  };
  const data = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    drain();
  };
  const close = () => {
    closed = true;
    buffer = '';
    input.off('data', data);
    input.off('end', end);
  };
  const end = () => {
    buffer += decoder.end();
    drain();
    if (!closed && buffer) onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    close();
  };
  input.on('data', data);
  input.on('end', end);
  return close;
}
