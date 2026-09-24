import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { readPiJsonLines } from '../adapters/pi-jsonl.js';
import { PiFinalizeStream } from '../adapters/pi-finalize-stream.js';

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

describe('Pi delta-only finalize argument reconstruction', () => {
  it('decodes partial strings, escapes and split Unicode without unstable prefixes', () => {
    const stream = new PiFinalizeStream();
    stream.update({ type: 'toolcall_start', contentIndex: 0, id: 'f1', toolName: 'finalize_reply' });
    const expected = 'line\n"quoted" \\ 你好😀';
    const json = JSON.stringify({ resummarize: true, text: expected }).replace('😀', '\\ud83d\\ude00');
    let previous = '';
    for (const delta of json) {
      const value = stream.update({ type: 'toolcall_delta', contentIndex: 0, delta });
      if (!value) continue;
      expect(expected.startsWith(value.text)).toBe(true);
      expect(value.text.startsWith(previous)).toBe(true);
      expect(/[\uD800-\uDBFF]$/.test(value.text)).toBe(false);
      previous = value.text;
    }
    expect(previous).toBe(expected);
  });

  it('isolates interleaved content blocks and ignores unrelated tools', () => {
    const stream = new PiFinalizeStream();
    stream.update({ type: 'toolcall_start', contentIndex: 0, id: 'f', toolName: 'finalize_reply' });
    stream.update({ type: 'toolcall_start', contentIndex: 1, id: 'b', toolName: 'bash' });
    expect(stream.update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"text":"not-final' })).toBeUndefined();
    expect(stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"text":"final' })).toEqual({ id: 'f', text: 'final' });
  });

  it('reconciles authoritative toolcall_end and retires its partial state', () => {
    const stream = new PiFinalizeStream();
    stream.update({ type: 'toolcall_start', contentIndex: 0, id: 'f', toolName: 'finalize_reply' });
    expect(stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"text":"par' })).toEqual({ id: 'f', text: 'par' });
    expect(stream.update({ type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'f', name: 'finalize_reply', arguments: { text: 'partial complete' } } })).toEqual({ id: 'f', text: 'partial complete' });
    expect(stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: 'stale' })).toBeUndefined();
  });

  it('clears a previous assistant message and reused block index', () => {
    const stream = new PiFinalizeStream();
    stream.update({ type: 'toolcall_start', contentIndex: 0, id: 'old', toolName: 'finalize_reply' });
    stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"text":"old' });
    stream.clear();
    expect(stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: 'stale' })).toBeUndefined();
    stream.update({ type: 'toolcall_start', contentIndex: 0, id: 'new', toolName: 'finalize_reply' });
    expect(stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"text":"new' })).toEqual({ id: 'new', text: 'new' });
  });

  it('does not throw on incomplete or malformed argument JSON', () => {
    const stream = new PiFinalizeStream();
    stream.update({ type: 'toolcall_start', contentIndex: 0, id: 'f', toolName: 'finalize_reply' });
    expect(stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: 'broken' })).toBeUndefined();
  });
});
