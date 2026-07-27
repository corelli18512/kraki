import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryPiCatalog, PiAdapter } from '../adapters/pi.js';

const tempDirs: string[] = [];

function fakePi(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kraki-pi-catalog-'));
  tempDirs.push(dir);
  const path = join(dir, 'pi');
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('queryPiCatalog — throwaway RPC lifecycle', () => {
  it('sends get_available_models and returns the catalog', async () => {
    const cli = fakePi(`
      process.stdin.once('data', chunk => {
        const command = JSON.parse(String(chunk));
        if (command.type !== 'get_available_models') process.exit(2);
        console.log(JSON.stringify({
          id: command.id,
          type: 'response',
          command: 'get_available_models',
          success: true,
          data: { models: [{ id: 'opus', provider: 'anthropic', reasoning: true, thinkingLevelMap: { max: 'max' } }] },
        }));
      });
    `);

    await expect(queryPiCatalog(cli, 2000)).resolves.toEqual([
      { id: 'opus', provider: 'anthropic', reasoning: true, thinkingLevelMap: { max: 'max' } },
    ]);
  });

  it('rejects an explicit RPC error instead of treating it as an empty catalog', async () => {
    const cli = fakePi(`
      process.stdin.once('data', chunk => {
        const command = JSON.parse(String(chunk));
        console.log(JSON.stringify({ id: command.id, type: 'response', command: 'get_available_models', success: false, error: 'catalog unavailable' }));
      });
    `);

    await expect(queryPiCatalog(cli, 2000)).rejects.toThrow('catalog unavailable');
  });

  it('rejects when pi exits before answering and includes stderr', async () => {
    const cli = fakePi(`
      console.error('provider init failed');
      process.exit(7);
    `);

    await expect(queryPiCatalog(cli, 2000)).rejects.toThrow(/pi exited before answering: provider init failed/);
  });

  it('retries after a transient catalog failure instead of caching fallback forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-pi-catalog-retry-'));
    tempDirs.push(dir);
    const marker = join(dir, 'attempted');
    const cli = join(dir, 'pi');
    writeFileSync(cli, `#!/usr/bin/env node
      const fs = require('node:fs');
      const marker = ${JSON.stringify(marker)};
      if (process.argv.includes('--list-models')) {
        console.log('provider   model   context   max-out   thinking   images');
        console.log('anthropic  opus    200K      32K       yes        no');
      } else {
        process.stdin.once('data', chunk => {
          const command = JSON.parse(String(chunk));
          if (!fs.existsSync(marker)) {
            fs.writeFileSync(marker, '1');
            console.log(JSON.stringify({ id: command.id, type: 'response', command: 'get_available_models', success: false, error: 'temporary failure' }));
          } else {
            console.log(JSON.stringify({ id: command.id, type: 'response', command: 'get_available_models', success: true, data: { models: [{ id: 'opus', provider: 'anthropic', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } }] } }));
          }
        });
      }
    `, 'utf8');
    chmodSync(cli, 0o755);
    const adapter = new PiAdapter({ cliPath: cli });

    const first = await adapter.listModelDetails();
    expect(first[0]?.supportedReasoningEfforts).toEqual(['high', 'xhigh']);

    const second = await adapter.listModelDetails();
    expect(second[0]?.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('times out and terminates a non-responsive child', async () => {
    const cli = fakePi(`
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `);
    const started = Date.now();

    await expect(queryPiCatalog(cli, 80)).rejects.toThrow('pi catalog query timed out');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
