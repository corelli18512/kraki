// Turn behaviour across agents, against the LOCAL stack only (never production).
//
//   E2E_PORT=4490 E2E_AGENTS=pi,codex,copilot,claude npx tsx scripts/e2e/turn-behaviour.mts > out.json
//
// For each agent: one session, then these turns in order, each waiting for its
// idle. What landed (spine rows, Steps, live idles) is printed as JSON so two
// runs (e.g. before/after an adapter change) can be compared structurally.
//   reply        plain answer, no tools
//   narrate      "Let me check." → shell tool → "Result: …"
//   toolOnly     a tool and nothing after it
//   steer        a long tool, then a steer mid-turn (same turn, one idle)
//   abort        a long tool, then Stop (silent end, nothing after it)
//   afterAbort   a plain answer right after the stopped turn
//   approve      safe mode: a shell command asks first; approved → it runs
//   deny         safe mode: denied with a reason → the agent is told why
//   question     the agent asks (ask_user); the answer comes back
// Expectations (Pi is the reference): one idle per turn; the reply is never
// also the last Step; a stopped turn has turn_status user_abort and nothing
// after it.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectApp, sendToTentacle, subscribeApp, tentacleTarget, waitMs } from '../../packages/tests/src/helpers.ts';

const PORT = Number(process.env.E2E_PORT ?? 4490);
const SESSIONS = resolve(process.cwd(), '.tmp/kraki-local/sessions');
const AGENTS = (process.env.E2E_AGENTS ?? 'pi,codex,copilot,claude').split(',');
const MODELS: Record<string, string | undefined> = {
  pi: process.env.E2E_PI_MODEL ?? 'deepseek/deepseek-flash',
  codex: process.env.E2E_CODEX_MODEL ?? 'gpt-6-luna',
  copilot: process.env.E2E_COPILOT_MODEL ?? 'auto',
  claude: process.env.E2E_CLAUDE_MODEL,
};
const now = () => new Date().toISOString();
const err = (...a: unknown[]) => console.error('[turns]', ...a);

type Row = { seq?: number; turnStartSeq?: number; type: string; payload: string };
const rows = (sid: string, file: string): Row[] => {
  const p = join(SESSIONS, sid, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const inner = (r: Row) => JSON.parse(r.payload).payload ?? {};
const short = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const maxSeq = (sid: string) => Math.max(0, ...rows(sid, 'messages.jsonl').map((r) => r.seq ?? 0));

const PROMPTS = {
  reply: 'Reply with exactly this sentence and nothing else, without using any tools: The sky is blue.',
  narrate: 'First write exactly "Let me check." as a short message. Then use your shell/bash tool to run `echo kraki-ok`. Then reply with exactly "Result: kraki-ok". Do nothing else.',
  toolOnly: 'Use your shell/bash tool to run `echo bye`. After the tool has run, end your turn without writing any text at all.',
  long: 'Use your shell/bash tool to run `sleep 25`, then reply with exactly "Slept.".',
  steer: 'Also: put the word pineapple in your final reply.',
  afterAbort: 'Reply with exactly: Back again.',
  gated: 'Use your shell/bash tool to run `echo gated-ok`, then reply with exactly the command output.',
  question: 'Call your ask_user tool (the tool for asking the user a question) with the question "Which color?" and the choices ["Red", "Blue"]. After I answer, reply with exactly "You chose X." where X is my answer. Use no other tools.',
};

async function main() {
  const app = await connectApp(PORT, 'Turn behaviour');
  const t = tentacleTarget(app);
  let greeting: any;
  for (let i = 0; i < 100 && !greeting; i++) {
    greeting = app.messages.find((m) => m.type === 'device_greeting' && m.deviceId === t.id);
    if (!greeting) await waitMs(100);
  }
  const offered: any[] = greeting?.payload?.agents ?? [];
  const out: Record<string, unknown> = {};

  for (const agent of AGENTS) {
    const info = offered.find((a) => a.id === agent);
    if (!info) { out[agent] = { skipped: 'not offered' }; continue; }
    const model = MODELS[agent] ?? (info.models ?? [])[0]?.id ?? (info.models ?? [])[0];
    const requestId = `turns-${agent}-${Date.now()}`;
    sendToTentacle(app, { type: 'create_session', deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { requestId, targetDeviceId: t.id, agentId: agent, model } });
    const created = await waitForMsg(app, (m) => m.type === 'session_created' && (m.payload as any)?.requestId === requestId, 90_000)
      ?? await app.waitFor('session_created', 90_000);
    const sid = created.sessionId as string;
    await subscribeApp(app, sid);
    err(agent, model, sid);
    const result: Record<string, unknown> = { model, sessionId: sid };

    const send = (text: string, delivery?: 'steer') => sendToTentacle(app, {
      type: 'send_input', sessionId: sid, deviceId: app.deviceId, seq: 0, timestamp: now(),
      payload: { clientId: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, ...(delivery && { delivery }) },
    });
    const idleAfter = (before: number) => rows(sid, 'messages.jsonl').some((r) => (r.seq ?? 0) > before && r.type === 'idle');
    const toolStarted = (before: number) => rows(sid, 'trace.jsonl').some((r) => (r.turnStartSeq ?? 0) > before && r.type === 'tool_start');
    const liveIdles = () => app.messages.filter((m) => m.sessionId === sid && m.type === 'idle').length;

    const turn = async (name: string, run: (before: number) => Promise<void>) => {
      const before = maxSeq(sid);
      const idles0 = liveIdles();
      const started = Date.now();
      try {
        await run(before);
        await until(() => idleAfter(before), 240_000, `${agent}/${name} idle`);
        await waitMs(name === 'abort' ? 8000 : 2500); // late events would land here
      } catch (e) { err(String(e)); }
      const spine = rows(sid, 'messages.jsonl').filter((r) => (r.seq ?? 0) > before);
      const steps = rows(sid, 'trace.jsonl').filter((r) => (r.turnStartSeq ?? 0) > before);
      const replies = spine.filter((r) => r.type === 'agent_message' && !inner(r).question).map((r) => short(inner(r).content));
      const narrations = steps.filter((r) => r.type === 'agent_narration' && !inner(r).parentToolCallId).map((r) => short(inner(r).content));
      result[name] = {
        ms: Date.now() - started,
        spine: spine.map((r) => {
          const p = inner(r);
          if (r.type === 'agent_message') return p.question ? `question:${short(p.question.question)}` : `reply:${short(p.content)}`;
          if (r.type === 'turn_status') return `turn_status:${p.action?.type ?? ''}${p.draft ? '+draft' : ''}`;
          if (r.type === 'system_message') return `system:${p.kind}`;
          if (r.type === 'error') return `error:${short(p.message)}`;
          if (r.type === 'user_message') return p.answerTo ? 'user(answer)' : p.delivery === 'steer' ? 'user(steer)' : 'user';
          return r.type;
        }),
        steps: steps.map((r) => {
          const p = inner(r);
          if (r.type === 'agent_narration') return `narration:${short(p.content)}`;
          if (r.type === 'tool_start' || r.type === 'tool_complete') return `${r.type}:${p.toolName}`;
          if (r.type === 'permission') return `permission:${p.decision ?? (p.cancelled ? 'cancelled' : '?')}`;
          return r.type;
        }),
        idleRows: spine.filter((r) => r.type === 'idle').length,
        liveIdles: liveIdles() - idles0,
        replyAlsoLastStep: replies.length > 0 && narrations.at(-1) === replies.at(-1),
      };
      err(agent, name, JSON.stringify(result[name]));
    };

    await turn('reply', async () => { send(PROMPTS.reply); });
    await turn('narrate', async () => { send(PROMPTS.narrate); });
    await turn('toolOnly', async () => { send(PROMPTS.toolOnly); });
    await turn('steer', async (before) => {
      send(PROMPTS.long);
      await until(() => toolStarted(before), 120_000, 'steer: tool start');
      await waitMs(1500);
      send(PROMPTS.steer, 'steer');
    });
    await turn('abort', async (before) => {
      send(PROMPTS.long);
      await until(() => toolStarted(before), 120_000, 'abort: tool start');
      await waitMs(1500);
      sendToTentacle(app, { type: 'abort_session', sessionId: sid, deviceId: app.deviceId, seq: 0, timestamp: now(), payload: {} });
    });
    await turn('afterAbort', async () => { send(PROMPTS.afterAbort); });

    const openPermission = (since: number) => {
      const cards = app.messages.slice(since).filter((m) => m.sessionId === sid && m.type === 'card_action');
      const action = (cards.at(-1)?.payload as any)?.action;
      return action?.type === 'permission' && !action.payload?.decision ? action.payload.id as string : undefined;
    };
    sendToTentacle(app, { type: 'set_session_mode', sessionId: sid, deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { mode: 'safe' } });
    await waitMs(1000);
    for (const decision of ['approve', 'deny'] as const) {
      await turn(decision, async () => {
        const since = app.messages.length;
        send(PROMPTS.gated);
        let id: string | undefined;
        await until(() => !!(id = openPermission(since)), 120_000, `${decision}: permission card`);
        await waitMs(800);
        sendToTentacle(app, {
          type: decision, sessionId: sid, deviceId: app.deviceId, seq: 0, timestamp: now(),
          payload: { permissionId: id, ...(decision === 'deny' && { reason: 'not now, thanks' }) },
        });
      });
    }
    sendToTentacle(app, { type: 'set_session_mode', sessionId: sid, deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { mode: 'auto' } });
    await waitMs(1000);
    await turn('question', async (before) => {
      send(PROMPTS.question);
      let q: any;
      await until(() => !!(q = rows(sid, 'messages.jsonl').find((r) => (r.seq ?? 0) > before && r.type === 'agent_message' && inner(r).question)), 120_000, 'question');
      await waitMs(800);
      const qid = inner(q).question.id;
      sendToTentacle(app, { type: 'send_input', sessionId: sid, deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { clientId: `ans-${Date.now()}`, text: 'Blue', answerTo: qid } });
    });
    out[agent] = result;
  }
  console.log(JSON.stringify(out, null, 2));
  app.close();
  process.exit(0);
}

async function until(fn: () => boolean, timeout: number, what: string) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await waitMs(300); }
  throw new Error(`timeout: ${what}`);
}
async function waitForMsg(app: { messages: Record<string, unknown>[] }, pred: (m: Record<string, unknown>) => boolean, timeout: number) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const m = app.messages.find(pred); if (m) return m; await waitMs(200); }
  return undefined;
}
main().catch((e) => { console.error('[turns] FAIL', e); process.exit(1); });
