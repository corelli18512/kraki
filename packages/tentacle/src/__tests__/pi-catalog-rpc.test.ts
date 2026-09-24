import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryPiCatalog, PiAdapter } from '../adapters/pi.js';

const tempDirs: string[] = [];
let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'kraki-pi-settings-'));
  tempDirs.push(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
});

function fakePi(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kraki-pi-catalog-'));
  tempDirs.push(dir);
  const path = join(dir, 'pi');
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
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

  it('preserves Unicode separators inside a valid catalog JSON record', async () => {
    const model = { id: 'model', provider: 'test', name: 'line\u2028paragraph\u2029end' };
    const cli = fakePi(`
      process.stdin.once('data', chunk => {
        const command = JSON.parse(String(chunk));
        console.log(JSON.stringify({ id: command.id, type: 'response', command: 'get_available_models', success: true, data: { models: [${JSON.stringify(model)}] } }));
      });
    `);
    await expect(queryPiCatalog(cli, 2000)).resolves.toEqual([model]);
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

  it('scopes both capability lists, rereads settings over a cached catalog, and chooses a scoped default', async () => {
    const catalog = [
      { provider: 'proxy', id: 'gpt-6-sol' },
      { provider: 'openai-codex', id: 'gpt-6-astra' },
      { provider: 'openai-codex', id: 'gpt-6-sol' },
      { provider: 'deepseek', id: 'deepseek-flash' },
      { provider: 'deepseek', id: 'deepseek-v4-pro' },
    ];
    const cli = fakePi(`
      const models = ${JSON.stringify(catalog)};
      if (process.argv.includes('--list-models')) {
        const row = cols => cols.map(c => c.padEnd(24)).join('');
        console.log(row(['provider', 'model', 'context', 'max-out', 'thinking', 'images']));
        for (const m of models) console.log(row([m.provider, m.id, '200K', '32K', 'yes', 'no']));
      } else {
        process.stdin.once('data', chunk => {
          const c = JSON.parse(String(chunk));
          console.log(JSON.stringify({ id: c.id, type: 'response', command: c.type, success: true, data: { models } }));
        });
      }
    `);
    const settings = join(agentDir, 'settings.json');
    const scope = ['openai-codex/gpt-6-astra', 'openai-codex/gpt-6-sol', 'deepseek/deepseek-flash'];
    writeFileSync(settings, JSON.stringify({ enabledModels: scope }));
    const adapter = new PiAdapter({ cliPath: cli });
    const defaultModel = () => (adapter as unknown as { getDefaultModel(): string }).getDefaultModel();
    expect(await adapter.listModels()).toEqual(scope);
    expect((await adapter.listModelDetails()).map(m => m.id)).toEqual(scope);
    expect(defaultModel()).toBe(scope[0]);

    writeFileSync(settings, JSON.stringify({ enabledModels: [scope[2]] }));
    expect(await adapter.listModels()).toEqual([scope[2]]);
    expect((await adapter.listModelDetails()).map(m => m.id)).toEqual([scope[2]]);
    expect(defaultModel()).toBe(scope[2]);
    writeFileSync(settings, '{');
    expect(await adapter.listModels()).toEqual([scope[2]]); // retain last valid preference

    writeFileSync(settings, JSON.stringify({ enabledModels: ['missing/*'] }));
    expect(await adapter.listModels()).toEqual([]);
    expect(defaultModel).toThrow('No Pi models match');
    writeFileSync(settings, '{}');
    expect(await adapter.listModels()).toHaveLength(5);
    expect(defaultModel()).toBe('deepseek/deepseek-v4-pro'); // legacy unscoped default
    writeFileSync(settings, '{');
    expect(await new PiAdapter({ cliPath: cli }).listModels()).toEqual([]);
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
