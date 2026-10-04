/**
 * Deterministic agent for resilience tests. Every input is recorded in a
 * ledger (exactly-once checks); each turn streams a few deltas and ends with
 * one numbered agent message, so clients can verify inbound completeness.
 * No model process, no network, no cost.
 */
import type { AgentAdapter, CreateSessionConfig, SessionInfo, SessionContext } from '@kraki/tentacle';

export interface ScriptedOptions {
  replyDelayMs: number; deltas: number; deltaIntervalMs: number;
  /** Tool steps before the reply (a real running turn shows these on the card). */
  tools?: number; toolIntervalMs?: number;
  /** Extra words appended to each reply so it streams for longer. */
  padWords?: number;
}

export class ScriptedAdapter {
  onSessionCreated: ((event: { sessionId: string; agent: string; model?: string }) => void) | null = null;
  onMessage: ((sessionId: string, event: { content: string }) => void) | null = null;
  onMessageDelta: ((sessionId: string, event: { content: string }) => void) | null = null;
  onNarration = null; onNarrationTrace = null; onPermissionRequest = null; onPermissionAutoResolved = null;
  onQuestionAutoResolved = null; onQuestionRequest = null;
  onToolStart: ((sessionId: string, event: { toolName: string; args: Record<string, unknown>; toolCallId?: string }) => void) | null = null;
  onToolComplete: ((sessionId: string, event: { toolName: string; result: string; toolCallId?: string; success?: boolean }) => void) | null = null;
  onAttachmentBytes = null; onFlushComplete = null; onCompaction = null; onSystemMessage = null;
  onSessionEvicted = null; onTitleChanged = null; onUsageUpdate = null;
  onIdle: ((sessionId: string) => void) | null = null;
  onError: ((sessionId: string, event: { message: string }) => void) | null = null;
  onSessionEnded: ((sessionId: string, event: { reason: string }) => void) | null = null;

  /** text → times received (per session). */
  readonly received = new Map<string, Map<string, number>>();
  /** Agent messages emitted, in order (per session). */
  readonly emitted = new Map<string, string[]>();
  private sessions = new Set<string>();
  private counter = 0;
  private chain = new Map<string, Promise<void>>();

  constructor(public options: ScriptedOptions = { replyDelayMs: 150, deltas: 4, deltaIntervalMs: 80 }) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  setTurnIdentity(): void {}
  isTurnSettled(): boolean { return true; }

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    const sessionId = config?.sessionId ?? `scripted_${++this.counter}`;
    this.sessions.add(sessionId);
    this.onSessionCreated?.({ sessionId, agent: 'scripted', model: 'scripted-v1' });
    return { sessionId };
  }
  async resumeSession(sessionId: string, _context?: SessionContext): Promise<{ sessionId: string }> {
    this.sessions.add(sessionId);
    return { sessionId };
  }
  async forkSession(_source: string, newSessionId: string): Promise<{ sessionId: string }> {
    return this.createSession({ sessionId: newSessionId } as CreateSessionConfig);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const bucket = this.received.get(sessionId) ?? new Map<string, number>();
    bucket.set(text, (bucket.get(text) ?? 0) + 1);
    this.received.set(sessionId, bucket);
    this.enqueue(sessionId, () => this.turn(sessionId, `reply to ${text}`));
  }

  /** Emit `count` agent turns without any input (inbound traffic). */
  burst(sessionId: string, count: number, prefix = 'burst', bytes = 0): void {
    for (let i = 0; i < count; i++) {
      const body = `${prefix} ${i + 1}/${count}` + (bytes > 0 ? ' ' + 'x'.repeat(bytes) : '');
      this.enqueue(sessionId, () => this.turn(sessionId, body));
    }
  }

  private enqueue(sessionId: string, job: () => Promise<void>): void {
    const prev = this.chain.get(sessionId) ?? Promise.resolve();
    this.chain.set(sessionId, prev.then(job, job));
  }

  private async turn(sessionId: string, content: string): Promise<void> {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(this.options.replyDelayMs);
    for (let t = 0; t < (this.options.tools ?? 0); t++) {
      const toolCallId = `tool_${++this.counter}`;
      this.onToolStart?.(sessionId, { toolName: 'bash', args: { command: `step ${t + 1}` }, toolCallId });
      await wait(this.options.toolIntervalMs ?? 500);
      this.onToolComplete?.(sessionId, { toolName: 'bash', result: `ok ${t + 1}`, toolCallId, success: true });
    }
    if (this.options.padWords) content = `${content} ${Array.from({ length: this.options.padWords }, (_, i) => `w${i + 1}`).join(' ')}`;
    const words = content.split(' ');
    const step = Math.max(1, Math.ceil(words.length / Math.max(1, this.options.deltas)));
    for (let i = 0; i < words.length; i += step) {
      this.onMessageDelta?.(sessionId, { content: words.slice(i, i + step).join(' ') + ' ' });
      await wait(this.options.deltaIntervalMs);
    }
    const list = this.emitted.get(sessionId) ?? [];
    list.push(content);
    this.emitted.set(sessionId, list);
    this.onMessage?.(sessionId, { content });
    this.onIdle?.(sessionId);
  }

  async respondToPermission(): Promise<void> {}
  async respondToQuestion(): Promise<void> {}
  async killSession(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
  async abortSession(): Promise<void> {}
  async endSession(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions].map((id) => ({ id, state: 'active' as const }));
  }
  async listModels(): Promise<string[]> { return ['scripted-v1']; }
  getSessionUsage(): null { return null; }
  setSessionMode(): void {}
  registerSessionAgent(): void {}
  setSessionUsage(): void {}
  updateAllowList(): void {}
  async generateTitle(): Promise<null> { return null; }
  async setSessionModel(): Promise<void> {}

  asAdapter(): AgentAdapter { return this as unknown as AgentAdapter; }
}
