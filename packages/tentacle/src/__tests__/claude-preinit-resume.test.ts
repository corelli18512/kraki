import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../adapters/claude.js';
import { claudeResumeTarget } from '../adapters/claude-resume.js';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }));
const uuid = '12345678-1234-4123-8123-123456789abc';
const other = '12345678-1234-4123-8123-123456789def';
let root: string, saved: Record<string, string | undefined>;
const adapters: ClaudeAdapter[] = [];
function adapter() { const a = new ClaudeAdapter(); adapters.push(a); return a; }
function transcript(home: string, id: string) {
  const dir = join(home, 'projects', '-tmp-review'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kraki-preinit-resume-')); saved = {};
  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_)/.test(key)) { saved[key] = process.env[key]; delete process.env[key]; }
  }
  for (const key of ['HOME', 'KRAKI_HOME']) { saved[key] = process.env[key]; process.env[key] = root; }
  sdk.query.mockReset().mockImplementation(() => ({
    [Symbol.asyncIterator]: async function* () { await new Promise(() => {}); },
  }));
});
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop();
  for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_)/.test(key)) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

describe('Claude restart before SDK init', () => {
  it('starts a fresh SDK query for the same Kraki session, preserving cwd/model/effort', async () => {
    await adapter().createSession({ sessionId: 'review-preinit', cwd: root, model: 'sonnet', reasoningEffort: 'low' });
    const resumed = adapter();
    await resumed.resumeSession('review-preinit');
    await resumed.sendMessage('review-preinit', 'retry the interrupted first turn');
    const options = sdk.query.mock.calls.at(-1)![0].options;
    expect(options).not.toHaveProperty('resume');
    expect(options).not.toHaveProperty('forkSession');
    expect(options).toMatchObject({ cwd: root, model: 'sonnet', effort: 'low' });
  });

  it('recovers a transcript written before the SDK init sidecar could be saved', async () => {
    const before = adapter();
    await before.createSession({ sessionId: 'review-init-race', cwd: root });
    transcript(join(root, 'sessions/review-init-race/claude-home'), uuid);
    const resumed = adapter();
    await resumed.resumeSession('review-init-race');
    await resumed.sendMessage('review-init-race', 'continue');
    expect(sdk.query.mock.calls.at(-1)![0].options.resume).toBe(uuid);
    expect(resumed.sdkSessionIds.get('review-init-race')).toBe(uuid);
  });

  it('forks a not-yet-initialized session as an empty session, including after restart', async () => {
    const before = adapter();
    await before.createSession({ sessionId: 'empty', cwd: root, model: 'sonnet' });
    await before.forkSession('empty', 'fork');
    const after = adapter(); await after.resumeSession('fork'); await after.sendMessage('fork', 'first');
    expect(sdk.query.mock.calls.at(-1)![0].options).not.toHaveProperty('resume');
    expect(sdk.query.mock.calls.at(-1)![0].options).not.toHaveProperty('forkSession');
  });

  it('retains explicit SDK IDs, fork lineage and legacy UUID-based session IDs', () => {
    expect(claudeResumeTarget('kraki-id', { sdkSessionId: uuid, forkFrom: other }, root)).toBe(uuid);
    expect(claudeResumeTarget('kraki-id', { forkFrom: uuid }, root)).toBe(uuid);
    expect(claudeResumeTarget(uuid, null, root)).toBe(uuid);
  });

  it('does not silently drop history when metadata is missing or transcripts are ambiguous', () => {
    expect(() => claudeResumeTarget('kraki-id', null, root)).toThrow(/metadata is missing/);
    transcript(root, uuid); transcript(root, other);
    expect(() => claudeResumeTarget('kraki-id', {}, root)).toThrow(/multiple transcripts/);
    expect(claudeResumeTarget(uuid, null, root)).toBe(uuid);
  });

  it('does not resume an empty transcript created before the first append', () => {
    transcript(root, uuid);
    writeFileSync(join(root, 'projects/-tmp-review', `${uuid}.jsonl`), '');
    expect(claudeResumeTarget('uninitialized', {}, root)).toBeUndefined();
    expect(() => claudeResumeTarget('broken', [] as never, root)).toThrow(/metadata is missing/);
  });

  it('does not infer a primary session from subagent logs', () => {
    const nested = join(root, 'projects/-tmp-review/subagents'); mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, `${uuid}.jsonl`), '{}\n');
    expect(claudeResumeTarget('uninitialized', {}, root)).toBeUndefined();
  });
});
