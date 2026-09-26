/**
 * ClaudeAdapter contract tests against an SDK-shaped mock of
 * @anthropic-ai/claude-agent-sdk. Cases C1–C7 originate from the 2026-09-24
 * Claude/Copilot runtime audit; the rest pin the 2026-09-26 fixes (Keychain
 * pinning, SDK-owned auth, user stop boundary, clean shutdown, no_reply,
 * tool-less title side-call).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, secureStorageEnv, isClaudeLoggedOut } from '../adapters/claude.js';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }));

type RecordMessage = Record<string, unknown>;
interface ClaudeEntry { query: object | null; inputIterable: AsyncIterable<RecordMessage>; model?: string; turnFinalized?: boolean }
interface ClaudeInternals { sessions: Map<string, ClaudeEntry>; handleSDKMessage: (id: string, msg: RecordMessage) => void }

let root: string, saved: Record<string, string | undefined>, claude: ClaudeAdapter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kraki-claude-contract-')); saved = {};
  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_)/.test(key)) { saved[key] = process.env[key]; delete process.env[key]; }
  }
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) if (!(key in saved)) saved[key] = undefined;
  for (const [key, value] of Object.entries({ HOME: root, KRAKI_HOME: join(root, 'kraki') })) {
    saved[key] = process.env[key]; process.env[key] = value; mkdirSync(value, { recursive: true });
  }
  claude = new ClaudeAdapter();
  sdk.query.mockReset().mockImplementation(() => ({
    supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }],
    [Symbol.asyncIterator]: async function* () {},
  }));
});

afterEach(async () => {
  await claude.stop(); vi.useRealTimers();
  for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_)/.test(key)) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

function cc() { return claude as unknown as ClaudeInternals; }
async function createClaude() { await claude.createSession({ sessionId: 's', cwd: root, model: 'sonnet', reasoningEffort: 'low' }); }
const nextTick = () => new Promise((r) => setTimeout(r, 0));

describe('ClaudeAdapter — audit findings C1–C7', () => {
  it('maps normal streamed text and the authoritative result to one conclusion', async () => {
    await createClaude(); claude.onMessageDelta = vi.fn(); claude.onMessage = vi.fn(); claude.onIdle = vi.fn();
    cc().handleSDKMessage('s', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } });
    cc().handleSDKMessage('s', { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } });
    cc().handleSDKMessage('s', { type: 'result', is_error: false });
    expect(claude.onMessageDelta).toHaveBeenCalledWith('s', { content: 'Hi' });
    expect(claude.onMessage).toHaveBeenCalledWith('s', { content: 'Hi' }); expect(claude.onIdle).toHaveBeenCalledTimes(1);
  });

  it('C1 passes image attachments into the SDK input message', async () => {
    await createClaude(); cc().sessions.get('s')!.query = {};
    const iterator = cc().sessions.get('s')!.inputIterable[Symbol.asyncIterator]();
    await claude.sendMessage('s', 'inspect this', [{ type: 'image', data: 'TEST_FIXTURE_BASE64', mimeType: 'image/png' }]);
    const input = (await iterator.next()).value as { message: { content: unknown } };
    expect(input.message.content).toEqual([
      { type: 'text', text: 'inspect this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'TEST_FIXTURE_BASE64' } },
    ]);
  });

  it('C1 also passes images on the very first (lazy) prompt', async () => {
    await createClaude();
    await claude.sendMessage('s', 'first', [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]);
    const iterator = (sdk.query.mock.calls[0][0].prompt as AsyncIterable<RecordMessage>)[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as { message: { content: unknown } };
    expect(JSON.stringify(first.message.content)).toContain('"media_type":"image/jpeg"');
  });

  it('C2 honors model and effort changes before the lazy first query', async () => {
    await createClaude(); await claude.setSessionModel('s', 'opus', 'high'); await claude.sendMessage('s', 'first');
    expect(sdk.query.mock.calls[0][0].options.model).toBe('opus');
    expect(sdk.query.mock.calls[0][0].options.effort).toBe('high');
  });

  it('C3 persists a live model + effort switch and applies both to the running query', async () => {
    await createClaude();
    const setModel = vi.fn().mockResolvedValue(undefined);
    const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
    cc().sessions.get('s')!.query = { setModel, applyFlagSettings };
    await claude.setSessionModel('s', 'opus', 'high');
    expect(setModel).toHaveBeenCalledWith('opus');
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high' });
    const meta = JSON.parse(readFileSync(join(root, 'kraki/sessions/s/.claude-adapter.json'), 'utf8'));
    expect(meta).toMatchObject({ model: 'opus', reasoningEffort: 'high' });

    // A fresh adapter resuming the session restores both.
    const resumed = new ClaudeAdapter();
    await resumed.resumeSession('s');
    await resumed.sendMessage('s', 'after restart');
    const opts = sdk.query.mock.calls.at(-1)![0].options;
    expect(opts).toMatchObject({ model: 'opus', effort: 'high' });
    await resumed.stop();
  });

  it('C4 lets the SDK verify login instead of requiring an API-key env var', async () => {
    sdk.query.mockImplementation(() => ({
      supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }],
      accountInfo: async () => ({ email: 'user@example.com', tokenSource: 'claude.ai', apiProvider: 'firstParty' }),
    }));
    await expect(claude.start()).resolves.toBeUndefined();
    expect(sdk.query).toHaveBeenCalled();
  });

  it('C4 refuses to start when the SDK reports no credential at all', async () => {
    sdk.query.mockImplementation(() => ({
      supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }],
      accountInfo: async () => ({ tokenSource: 'none', apiProvider: 'firstParty' }),
    }));
    await expect(claude.start()).rejects.toThrow(/not logged in/);
  });

  it('C5 uses an explicit CLAUDE_CONFIG_DIR when creating its session shadow', async () => {
    const custom = join(root, 'custom-claude'); mkdirSync(custom); mkdirSync(join(root, '.claude'));
    writeFileSync(join(custom, 'settings.json'), JSON.stringify({ marker: 'explicit-config' }));
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ marker: 'default-config' }));
    process.env.CLAUDE_CONFIG_DIR = custom;
    await createClaude(); await claude.sendMessage('s', 'first');
    const env = sdk.query.mock.calls[0][0].options.env;
    expect(JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).marker).toBe('explicit-config');
    // Secure storage (Keychain) stays keyed to the explicit root, not the shadow.
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(custom);
  });

  it('C6 resolves the local CLI opus[1m] alias through the configured model override', async () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-not-a-real-key', ANTHROPIC_DEFAULT_OPUS_MODEL: 'private-opus[1m]' } }));
    sdk.query.mockImplementation(() => ({ supportedModels: async () => [{ value: 'opus[1m]', displayName: 'Opus' }] }));
    await claude.start();
    expect(await claude.listModels()).toContain('private-opus[1m]');
    // ...and selecting that id sends the SDK alias back.
    await createClaude(); await claude.setSessionModel('s', 'private-opus[1m]'); await claude.sendMessage('s', 'x');
    expect(sdk.query.mock.calls.at(-1)![0].options.model).toBe('opus[1m]');
  });

  it('C7 maps native status/compact_boundary messages to compaction callbacks', async () => {
    await createClaude(); claude.onCompaction = vi.fn();
    cc().handleSDKMessage('s', { type: 'system', subtype: 'status', status: 'compacting' });
    cc().handleSDKMessage('s', { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100000 } });
    expect(claude.onCompaction).toHaveBeenNthCalledWith(1, 's', expect.objectContaining({ phase: 'start' }));
    expect(claude.onCompaction).toHaveBeenNthCalledWith(2, 's', expect.objectContaining({ phase: 'end' }));
    expect(claude.onCompaction).toHaveBeenCalledTimes(2);
  });
});

describe('ClaudeAdapter — Keychain, env isolation, auth detection', () => {
  it('pins secure storage to the default (unsuffixed) Keychain item when no CLAUDE_CONFIG_DIR is set', () => {
    expect(secureStorageEnv()).toEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' });
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '/user/choice';
    expect(secureStorageEnv()).toEqual({});
  });

  it('shadow sessions get CLAUDE_SECURESTORAGE_CONFIG_DIR so a subscription login is found', async () => {
    await createClaude(); await claude.sendMessage('s', 'first');
    const env = sdk.query.mock.calls[0][0].options.env;
    expect(env.CLAUDE_CONFIG_DIR).toContain(join('kraki', 'sessions', 's', 'claude-home'));
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('');
  });

  it('settings.json env reaches Claude children without leaking into the daemon env', async () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } }));
    await createClaude(); await claude.sendMessage('s', 'first');
    expect(sdk.query.mock.calls[0][0].options.env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('classifies accountInfo shapes observed from Claude Code 2.1.220', () => {
    expect(isClaudeLoggedOut({ tokenSource: 'none', apiProvider: 'firstParty' })).toBe(true);
    expect(isClaudeLoggedOut({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })).toBe(false);
    expect(isClaudeLoggedOut({ email: 'a@b.c', tokenSource: 'claude.ai', apiProvider: 'firstParty' })).toBe(false);
    expect(isClaudeLoggedOut({ apiProvider: 'bedrock' })).toBe(false);
    expect(isClaudeLoggedOut(undefined)).toBe(false);
  });
});

describe('ClaudeAdapter — turn lifecycle', () => {
  it('a user stop settles silently: no bubble, error or idle for the stopped turn', async () => {
    await createClaude();
    claude.onMessage = vi.fn(); claude.onIdle = vi.fn(); claude.onError = vi.fn(); claude.onSystemMessage = vi.fn();
    const interrupt = vi.fn(async () => {
      // The SDK delivers the interrupted turn's result while interrupt() is pending.
      cc().handleSDKMessage('s', { type: 'assistant', message: { content: [{ type: 'text', text: 'half a sentence' }] } });
      cc().handleSDKMessage('s', { type: 'result', is_error: true, subtype: 'error_during_execution' });
    });
    cc().sessions.get('s')!.query = { interrupt };
    claude.setTurnIdentity('s', 'rt-1');
    await claude.sendMessage('s', 'long task');
    await claude.abortSession('s');
    expect(interrupt).toHaveBeenCalled();
    expect(claude.onMessage).not.toHaveBeenCalled();
    expect(claude.onError).not.toHaveBeenCalled();
    expect(claude.onIdle).not.toHaveBeenCalled();
    expect(claude.isTurnSettled('s')).toBe(true);

    // The next turn is normal again.
    claude.setTurnIdentity('s', 'rt-2');
    await claude.sendMessage('s', 'next');
    cc().handleSDKMessage('s', { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
    cc().handleSDKMessage('s', { type: 'result', is_error: false });
    expect(claude.onMessage).toHaveBeenCalledWith('s', { content: 'done', turnId: 'rt-2' });
    expect(claude.onIdle).toHaveBeenCalledWith('s', { turnId: 'rt-2' });
  });

  it('stopping an idle session does not arm the stop flag', async () => {
    await createClaude(); claude.onIdle = vi.fn();
    cc().sessions.get('s')!.query = { interrupt: vi.fn() };
    cc().sessions.get('s')!.turnFinalized = true;
    await claude.abortSession('s');
    cc().handleSDKMessage('s', { type: 'result', is_error: false });
    // Already finalized → ignored either way; no crash, no spurious idle.
    expect(claude.onIdle).not.toHaveBeenCalled();
  });

  it('adapter stop is a clean shutdown, not a session error', async () => {
    sdk.query.mockImplementation(({ options }: { options: { abortController: AbortController } }) => ({
      [Symbol.asyncIterator]: async function* () {
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener('abort', () => resolve()));
        throw new Error('Operation aborted');
      },
    }));
    await createClaude(); claude.onError = vi.fn(); claude.onSessionEnded = vi.fn();
    await claude.sendMessage('s', 'first');
    await claude.stop();
    await nextTick(); await nextTick();
    expect(claude.onError).not.toHaveBeenCalled();
    expect(claude.onSessionEnded).not.toHaveBeenCalled();
  });

  it('a tool-only turn with no closing prose emits a no_reply anchor', async () => {
    await createClaude(); claude.onMessage = vi.fn(); claude.onSystemMessage = vi.fn(); claude.onIdle = vi.fn();
    cc().sessions.get('s')!.query = {};
    claude.setTurnIdentity('s', 'rt-1');
    await claude.sendMessage('s', 'touch a file');
    cc().handleSDKMessage('s', { type: 'user', message: { content: [] } });
    cc().handleSDKMessage('s', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'touch x' } }] } });
    cc().handleSDKMessage('s', { type: 'result', is_error: false });
    expect(claude.onMessage).not.toHaveBeenCalled();
    expect(claude.onSystemMessage).toHaveBeenCalledWith('s', { kind: 'no_reply', turnId: 'rt-1' });
    expect(claude.onIdle).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeAdapter — title side-call', () => {
  it('runs with no tools, no settings, denied permissions and no transcript', async () => {
    sdk.query.mockImplementation(() => ({
      [Symbol.asyncIterator]: async function* () { yield { type: 'result', result: 'Fix flaky stats tests' }; },
    }));
    const title = await claude.generateTitle({ firstUserMessage: 'please fix the stats tests' });
    expect(title).toBe('Fix flaky stats tests');
    const opts = sdk.query.mock.calls[0][0].options;
    expect(opts).toMatchObject({ tools: [], settingSources: [], persistSession: false, maxTurns: 1, model: 'haiku' });
    expect(opts.permissionMode).not.toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
    await expect(opts.canUseTool('Bash', {}, {})).resolves.toMatchObject({ behavior: 'deny' });
  });
});
