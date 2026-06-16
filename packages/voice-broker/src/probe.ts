/**
 * Phase 0 probe — stream a local audio file straight to Doubao (real or mock).
 *
 * Usage (from packages/voice-broker):
 *   pnpm probe -- --file path/to/clip.pcm
 *   pnpm probe -- --file path/to/clip.wav --mock
 *
 * Accepts:
 *   raw PCM (16 kHz, mono, 16-bit, little-endian) — default
 *   WAV files (PCM only)                          — auto-detected by extension
 *
 * Streams 200 ms chunks (6400 bytes at 16 kHz · 16-bit · mono) with realistic
 * pacing so you see partials arrive in roughly real-time.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { DoubaoClient, type TranscriptUpdate } from './doubao-client.js';
import { startMockDoubao } from './mock-doubao.js';
import { createLogger, levelFromEnv } from './logger.js';

interface ProbeArgs {
  file?: string;
  mock: boolean;
  rate: number;
  chunkMs: number;
  pace: boolean;
}

function parseArgs(argv: string[]): ProbeArgs {
  const out: ProbeArgs = { mock: false, rate: 16000, chunkMs: 200, pace: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') out.file = argv[++i];
    else if (a === '--mock') out.mock = true;
    else if (a === '--rate') out.rate = Number(argv[++i]);
    else if (a === '--chunk-ms') out.chunkMs = Number(argv[++i]);
    else if (a === '--no-pace') out.pace = false;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    [
      'kraki voice-broker probe — stream audio to Doubao ASR and print transcripts',
      '',
      'Options:',
      '  -f, --file <path>     PCM or WAV file to stream',
      '      --mock            Use the in-process mock Doubao server (no creds needed)',
      '      --rate <hz>       Audio sample rate (default 16000)',
      '      --chunk-ms <ms>   Chunk size in milliseconds (default 200)',
      '      --no-pace         Send chunks as fast as possible (default: paced)',
      '  -h, --help            Show this help',
      '',
      'When --mock is set or DOUBAO_MOCK=1, real credentials are not required.',
      '',
    ].join('\n'),
  );
}

function readAudio(path: string, rate: number): Buffer {
  const ext = extname(path).toLowerCase();
  const raw = readFileSync(path);
  if (ext === '.wav') {
    // Very small RIFF WAV parser — PCM only.
    if (raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('not a WAV file (missing RIFF/WAVE)');
    }
    let offset = 12;
    let dataStart = -1;
    let dataLen = 0;
    let fmtRate = rate;
    let fmtChannels = 1;
    let fmtBits = 16;
    while (offset + 8 <= raw.length) {
      const id = raw.toString('ascii', offset, offset + 4);
      const size = raw.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        // const audioFormat = raw.readUInt16LE(offset + 8); // 1 = PCM
        fmtChannels = raw.readUInt16LE(offset + 10);
        fmtRate = raw.readUInt32LE(offset + 12);
        fmtBits = raw.readUInt16LE(offset + 22);
      } else if (id === 'data') {
        dataStart = offset + 8;
        dataLen = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (dataStart < 0) throw new Error('no data chunk in WAV file');
    if (fmtChannels !== 1) throw new Error(`WAV must be mono (got ${fmtChannels} channels)`);
    if (fmtBits !== 16) throw new Error(`WAV must be 16-bit (got ${fmtBits})`);
    if (fmtRate !== rate) {
      throw new Error(`WAV rate ${fmtRate} ≠ --rate ${rate}. Resample externally or pass --rate ${fmtRate}.`);
    }
    return raw.subarray(dataStart, dataStart + dataLen);
  }
  return raw; // assume raw PCM
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger('probe', levelFromEnv(process.env.LOG_LEVEL));

  const useMock = args.mock || process.env.DOUBAO_MOCK === '1';
  let endpoint = process.env.DOUBAO_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
  let appKey = process.env.DOUBAO_APP_KEY ?? '';
  const accessKey = process.env.DOUBAO_ACCESS_KEY ?? '';
  const resourceId = process.env.DOUBAO_RESOURCE_ID ?? 'volc.bigasr.sauc.duration';
  let mock: Awaited<ReturnType<typeof startMockDoubao>> | null = null;

  if (useMock) {
    mock = await startMockDoubao({
      port: Number(process.env.MOCK_DOUBAO_PORT) || 0,
      requireAuthHeaders: false,
      logger: log.child('mock'),
    });
    endpoint = mock.url;
    appKey = appKey || 'mock-app-key';
  } else if (!accessKey) {
    log.error('missing credentials. Set DOUBAO_ACCESS_KEY (new console API Key) in .env, or pass --mock');
    process.exit(2);
  }

  // Build the audio source: a real file, or 2s of silence if no file given.
  let audio: Buffer;
  if (args.file) {
    audio = readAudio(args.file, args.rate);
    log.info('loaded audio', { file: args.file, bytes: audio.length, durationMs: Math.round((audio.length / (args.rate * 2)) * 1000) });
  } else {
    audio = Buffer.alloc(args.rate * 2 * 2); // 2 seconds of silence
    log.warn('no --file passed, sending 2s of silence (mock will still produce transcripts)');
  }

  const client = new DoubaoClient({
    appKey,
    accessKey,
    resourceId,
    endpoint,
    logger: log.child('doubao'),
  });

  // Swallow post-connect socket errors so the process exits cleanly via main()'s
  // try/catch instead of via the EventEmitter unhandled-error mechanism.
  client.on('error', () => {
    /* logged by the client itself */
  });

  client.on('transcript', (u: TranscriptUpdate) => {
    const tag = u.sessionFinal ? '◆ FINAL' : u.finalSegment ? '◇ segment' : '… partial';
    log.info(`${tag} ${u.text}`);
  });

  try {
    await client.connect();
  } catch (err) {
    log.error('could not connect to Doubao', { error: (err as Error).message });
    log.error('check DOUBAO_ACCESS_KEY (or legacy DOUBAO_APP_KEY+DOUBAO_ACCESS_KEY) and DOUBAO_RESOURCE_ID in .env');
    await mock?.close();
    process.exit(2);
  }
  client.start();

  const bytesPerChunk = (args.rate * 2 * args.chunkMs) / 1000;
  for (let i = 0; i < audio.length; i += bytesPerChunk) {
    const chunk = audio.subarray(i, Math.min(i + bytesPerChunk, audio.length));
    client.sendAudio(chunk);
    if (args.pace) await sleep(args.chunkMs);
  }
  client.finish();

  // Wait for final / close.
  await new Promise<void>((resolve) => {
    let done = false;
    client.once('final', () => {
      done = true;
      resolve();
    });
    client.once('close', () => {
      if (!done) resolve();
    });
    setTimeout(() => {
      if (!done) {
        log.warn('timeout waiting for final transcript');
        resolve();
      }
    }, 10_000);
  });

  client.close();
  await mock?.close();
  log.info('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
