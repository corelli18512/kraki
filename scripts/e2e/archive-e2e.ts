// Session archive (F2) end-to-end against the LOCAL stack only (never production):
//   KRAKI_LOCAL_RELAY_PORT=4410 KRAKI_LOCAL_WEB_PORT=3310 KRAKI_LOCAL_REDIRECT_PORT=3410 pnpm dev -- --no-open
//   E2E_PORT=4410 pnpm exec tsx scripts/e2e/archive-e2e.ts [seed]
// `seed` stops once the session is archived (for ArchiveE2EUITests).
// A real agent answers one cheap prompt; the session's last message is then
// back-dated and the computer is asked to archive, list, restore and delete.
import { existsSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectApp, sendToTentacle, subscribeApp, tentacleTarget, waitMs } from '../../packages/tests/src/helpers.ts';

const PORT = Number(process.env.E2E_PORT ?? 4410);
const SESSIONS = resolve(process.cwd(), '.tmp/kraki-local/sessions');
const log = (...a: unknown[]) => console.log('[archive-e2e]', ...a);
const now = () => new Date().toISOString();

async function main() {
  const app = await connectApp(PORT, 'Archive E2E');
  const t = tentacleTarget(app);
  let greeting: any;
  for (let i = 0; i < 100 && !greeting; i++) {
    greeting = app.messages.find((m) => m.type === 'device_greeting' && m.deviceId === t.id);
    if (!greeting) await waitMs(100);
  }
  const agents: any[] = greeting?.payload?.agents ?? [];
  log('agents', agents.map((a) => `${a.id}(${(a.models ?? []).length})`).join(' '));
  const agent = process.env.E2E_AGENT ?? (agents.find((a) => a.id === 'pi') ? 'pi' : agents[0]?.id);
  const models: string[] = (agents.find((a) => a.id === agent)?.models ?? []).map((m: any) => m.id ?? m);
  const model = process.env.E2E_MODEL ?? models.find((m) => /flash|haiku|mini/i.test(m)) ?? models[0];
  log('agent', agent, 'model', model);

  const lists = () => app.messages.filter((m) => m.type === 'session_list');
  const lastList = () => lists().at(-1)!.payload as { sessions: { id: string }[]; archivedCount?: number; autoArchiveDays?: number };
  const waitForList = async (pred: (p: ReturnType<typeof lastList>) => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (lists().length && pred(lastList())) return lastList();
      await waitMs(100);
    }
    throw new Error(`timed out waiting for session_list: ${what} — last ${JSON.stringify(lastList()).slice(0, 300)}`);
  };

  // 1. A real session with one short turn.
  const requestId = `arch-${Date.now()}`;
  sendToTentacle(app, { type: 'create_session', deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { requestId, targetDeviceId: t.id, agentId: agent, model, reasoningEffort: 'low' } });
  const created = await app.waitFor('session_created', 60_000);
  const sessionId = created.sessionId as string;
  log('session', sessionId, 'mode', (created.payload as any)?.mode);
  await subscribeApp(app, sessionId);
  sendToTentacle(app, { type: 'send_input', sessionId, deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { clientId: `c-${Date.now()}`, text: 'Reply with exactly: ok' } });
  for (let i = 0; i < 240; i++) {
    if (app.messages.some((m) => m.sessionId === sessionId && m.type === 'agent_message')) break;
    await waitMs(500);
  }
  const reply = app.messages.find((m) => m.sessionId === sessionId && m.type === 'agent_message');
  log('reply', JSON.stringify((reply?.payload as any)?.content ?? null));
  if (!reply) throw new Error('agent did not reply');
  await subscribeApp(app, null);

  // 2. Back-date the last message 20 days and lower the setting to 14 days.
  const logPath = join(SESSIONS, sessionId, 'messages.jsonl');
  const old = new Date(Date.now() - 20 * 86_400_000);
  utimesSync(logPath, old, old);
  sendToTentacle(app, { type: 'set_auto_archive_days', deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { targetDeviceId: t.id, days: 14 } });
  let list = await waitForList((p) => !p.sessions.some((s) => s.id === sessionId), 'session archived');
  log('after sweep: archivedCount', list.archivedCount, 'days', list.autoArchiveDays, 'listed', list.sessions.length);
  if (!list.archivedCount) throw new Error('archivedCount missing');

  // 3. The archive listing has it.
  sendToTentacle(app, { type: 'request_archived_sessions', deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { targetDeviceId: t.id, requestId: 'r1' } });
  const archived = await app.waitFor('archived_session_list', 10_000);
  const entry = (archived.payload as any).sessions.find((s: any) => s.id === sessionId);
  log('archived entry', JSON.stringify({ id: entry?.id, archived: entry?.archived, lastActivityAt: entry?.lastActivityAt }));
  if (!entry?.archived) throw new Error('not in archived list');
  if (process.argv[2] === 'seed') {
    // Leave it archived for the iOS/Mac UI test (ArchiveE2EUITests).
    log('SEEDED', sessionId);
    process.exit(0);
  }

  // 4. Opening it (subscribing) restores it.
  await subscribeApp(app, sessionId);
  list = await waitForList((p) => p.sessions.some((s) => s.id === sessionId), 'session restored on open');
  log('restored on open; archivedCount', list.archivedCount);
  await subscribeApp(app, null);

  // 5. Archive by hand, then delete all archived sessions.
  sendToTentacle(app, { type: 'archive_session', sessionId, deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { archived: true } });
  await waitForList((p) => !p.sessions.some((s) => s.id === sessionId), 'manual archive');
  sendToTentacle(app, { type: 'delete_archived_sessions', deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { targetDeviceId: t.id } });
  list = await waitForList((p) => p.archivedCount === 0, 'archived deleted');
  await waitMs(1500);
  log('after delete: archivedCount', list.archivedCount, 'dir exists', existsSync(join(SESSIONS, sessionId)));
  if (existsSync(join(SESSIONS, sessionId))) throw new Error('session directory left behind');

  log('PASS');
  process.exit(0);
}

main().catch((err) => { console.error('[archive-e2e] FAIL', err); process.exit(1); });
