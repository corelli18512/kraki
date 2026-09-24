import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { piSettingsPath, readPiModelScope, scopePiModels } from '../adapters/pi-model-scope.js';

const models = [
  { provider: 'proxy', model: 'gpt-6-sol' },
  { provider: 'openai-codex', model: 'gpt-6-astra' },
  { provider: 'openai-codex', model: 'gpt-6-sol' },
  { provider: 'openai-codex', model: 'gpt-6-luna' },
  { provider: 'deepseek', model: 'deepseek-flash' },
  { provider: 'deepseek', model: 'deepseek-v4-pro' },
  { provider: 'anthropic', model: 'claude-opus-5' },
  { provider: 'custom', model: 'org/model:exacto' },
];
const wanted = ['openai-codex/gpt-6-astra', 'openai-codex/gpt-6-sol', 'deepseek/deepseek-flash'];
const ids = (scope?: string[]) => scopePiModels(models, scope).map(m => `${m.provider}/${m.model}`);

describe('Pi enabledModels scope', () => {
  it('keeps precisely the requested official models, in preference order', () => {
    expect(ids(wanted)).toEqual(wanted);
    expect(ids(wanted)).not.toContain('proxy/gpt-6-sol');
  });
  it.each([undefined, []])('preserves the full catalog for an unset/empty scope: %s', scope => {
    expect(scopePiModels(models, scope)).toEqual(models);
  });
  it('uses case-insensitive provider globs, character classes and thinking suffixes', () => {
    expect(ids(['OPENAI-CODEX/gpt-6-[as]*:high'])).toEqual(wanted.slice(0, 2));
    expect(ids(['deepseek-?lash'])).toEqual(wanted.slice(2));
  });
  it('deduplicates overlapping patterns and preserves catalog order for glob expansion', () => {
    expect(ids(['openai-codex/gpt-6-sol', 'openai-codex/*', 'openai-codex/gpt-6-sol:high'])).toEqual([
      wanted[1], wanted[0], 'openai-codex/gpt-6-luna',
    ]);
  });
  it('never falls back to the full catalog for stale/nonmatching scopes', () => {
    expect(ids(['missing/*'])).toEqual([]);
    expect(ids(['missing/*', wanted[0]])).toEqual([wanted[0]]);
    expect(ids(['not-openai/gpt-6-sol'])).toEqual([]);
  });
  it('handles fuzzy IDs and prefers aliases over dated models as Pi does', () => {
    expect(ids(['astra:high'])).toEqual([wanted[0]]);
    const aliases = [{ provider: 'test', model: 'sonnet-20260101' }, { provider: 'test', model: 'sonnet' }];
    expect(scopePiModels(aliases, ['sonnet'])[0].model).toBe('sonnet');
  });
  it('preserves namespaced model IDs and literal colon IDs before parsing thinking suffixes', () => {
    expect(ids(['custom/org/model:exacto'])).toEqual(['custom/org/model:exacto']);
    expect(ids(['custom/org/model:exacto:max'])).toEqual(['custom/org/model:exacto']);
  });
  it('does not mutate the catalog', () => {
    const before = structuredClone(models);
    ids(['gpt', '*']);
    expect(models).toEqual(before);
  });
});

describe('Pi settings source', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-pi-scope-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
  it('reads the overridden agent directory and picks up edits and removals', () => {
    expect(readPiModelScope()).toBeUndefined();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: wanted }));
    expect(readPiModelScope()).toEqual(wanted);
    writeFileSync(join(dir, 'settings.json'), '{}');
    expect(readPiModelScope()).toBeUndefined();
  });
  it.each(['{', 'null', '[]', '{"enabledModels":"*"}', '{"enabledModels":[1]}'])('rejects invalid settings instead of ignoring the scope: %s', text => {
    writeFileSync(join(dir, 'settings.json'), text);
    expect(() => readPiModelScope()).toThrow();
  });
  it('resolves default and tilde paths without writing into the real user directory', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    expect(piSettingsPath()).toBe(join(homedir(), '.pi', 'agent', 'settings.json'));
    vi.stubEnv('PI_CODING_AGENT_DIR', '~/custom-pi');
    expect(piSettingsPath()).toBe(join(homedir(), 'custom-pi', 'settings.json'));
  });
});
