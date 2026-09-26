import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { readPiJsonLines } from '../adapters/pi-jsonl.js';

describe('Pi LF-only JSONL framing', () => {
  it('keeps Unicode separators in JSON strings and supports CRLF', () => {
    const stream = new PassThrough(), lines: string[] = [];
    const close = readPiJsonLines(stream, line => lines.push(line));
    const text = JSON.stringify({ text: '你好\u2028line\u2029😀' });
    stream.write(text + '\r\n{}\n');
    expect(lines).toEqual([text, '{}']); close();
  });

  it('decodes multibyte characters split at every byte boundary', () => {
    const stream = new PassThrough(), lines: string[] = [];
    const close = readPiJsonLines(stream, line => lines.push(line));
    const text = JSON.stringify({ text: '你好😀\u2028' });
    for (const byte of Buffer.from(text + '\n')) stream.write(Buffer.from([byte]));
    expect(lines).toEqual([text]); close();
  });

  it('buffers partial records and accepts an unterminated last record on EOF', async () => {
    const stream = new PassThrough(), lines: string[] = [];
    readPiJsonLines(stream, line => lines.push(line));
    stream.write('{"a":'); expect(lines).toEqual([]);
    stream.end('1}');
    await vi.waitFor(() => expect(lines).toEqual(['{"a":1}']));
  });

  it('stops within a multi-record chunk when the callback disposes the reader', () => {
    const stream = new PassThrough(), lines: string[] = [];
    const close = readPiJsonLines(stream, line => { lines.push(line); close(); });
    stream.write('{}\n{"ignored":true}\n'); stream.write('{}\n');
    expect(lines).toEqual(['{}']); expect(stream.listenerCount('data')).toBe(0);
  });
});
