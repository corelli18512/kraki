import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('declared Pi runtime contract', () => {
  it('installs the runtime version whose RPC implementation emits agent_settled', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = join(testDir, '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent');
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    const rpcMode = readFileSync(join(packageRoot, 'dist', 'modes', 'rpc', 'rpc-mode.js'), 'utf8');

    expect(packageJson.version).toBe('0.84.1');
    expect(rpcMode).toContain('agent_settled');
  });
});
