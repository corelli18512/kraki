// Seed the LOCAL stack (never production) with a few real Pi conversations
// used as the shared design reference for iOS / Mac / Web screenshots:
//   KRAKI_LOCAL_RELAY_PORT=4470 ... pnpm exec tsx scripts/dev-local.ts --no-open
//   pnpm exec tsx scripts/e2e/seed-design-sessions.ts
// Writes the created session ids to /tmp/kraki-design-sessions.json.
import { writeFileSync } from 'node:fs';
import { connectApp, sendToTentacle, subscribeApp, tentacleTarget, waitMs } from '../../packages/tests/src/helpers.ts';

const PORT = Number(process.env.KRAKI_LOCAL_RELAY_PORT ?? 4470);
const log = (...a: unknown[]) => console.log('[seed]', ...a);

async function main() {
  const app = await connectApp(PORT, 'Design Seed');
  const t = tentacleTarget(app);
  const dev = (app.authOk.devices as any[]).find((d) => d.id === t.id);
  const models: string[] = (dev?.models?.pi ?? dev?.agentModels?.pi ?? []).map((m: any) => m.id ?? m);
  const model = process.env.E2E_MODEL ?? models.find((m) => /haiku|mini|flash/i.test(m)) ?? models[0] ?? '';
  log('model', model);

  const spine = (sid: string) => app.messages.filter((m) => m.sessionId === sid && typeof m.seq === 'number');
  const now = () => new Date().toISOString();

  async function create(title: string): Promise<string> {
    const requestId = `seed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    sendToTentacle(app, { type: 'create_session', deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { requestId, targetDeviceId: t.id, agentId: 'pi', model } });
    const created = await app.waitFor('session_created', 60_000);
    const sid = created.sessionId as string;
    await subscribeApp(app, sid);
    sendToTentacle(app, { type: 'rename_session', sessionId: sid, deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { title } });
    return sid;
  }

  async function say(sid: string, text: string, until: 'idle' | 'question' = 'idle'): Promise<void> {
    const before = spine(sid).length;
    sendToTentacle(app, { type: 'send_input', sessionId: sid, deviceId: app.deviceId, seq: 0, timestamp: now(), payload: { text, clientId: `seed-${Date.now()}` } });
    for (let i = 0; i < 600; i++) {
      await waitMs(500);
      const fresh = spine(sid).slice(before);
      if (until === 'idle' && fresh.some((m) => m.type === 'idle' && fresh.some((x) => x.type === 'agent_message'))) return;
      if (until === 'question' && fresh.some((m) => m.type === 'agent_message' && (m.payload as any)?.question)) return;
    }
    throw new Error(`timeout waiting for ${until} in ${sid}`);
  }

  const ids: Record<string, string> = {};

  if (process.env.SEED === 'history') {
    // A long conversation for paging/scroll checks (older pages load on demand).
    ids.history = await create('Long history');
    const turns = Number(process.env.TURNS ?? 45);
    for (let i = 1; i <= turns; i++) {
      await say(ids.history, `History turn ${i}: reply with ${i % 4 === 0 ? 'a 5-item bulleted list about the number ' + i : 'one short sentence about the number ' + i}. No tools.`);
    }
    writeFileSync('/tmp/kraki-design-history.json', JSON.stringify(ids, null, 2));
    log('SESSIONS', JSON.stringify(ids));
    app.close();
    process.exit(0);
  }

  ids.rich = await create('Markdown showcase');
  await say(ids.rich, 'Run `ls /` with bash once. Then reply with a short Markdown showcase about a caching layer: an H2 heading, one paragraph with **bold**, *italic*, `inline code` and a link to https://example.com, a 3-item bullet list, a 2-step numbered list, a blockquote, a small 3x3 table, and a 6-line Swift code block. Keep it compact.');
  await say(ids.rich, 'Thanks. Now one short sentence summary, nothing else.');

  ids.long = await create('Many short turns');
  for (let i = 1; i <= 8; i++) await say(ids.long, `Turn ${i}: reply with exactly ${i % 3 === 0 ? 'three short sentences about the number ' + i : 'one short sentence about the number ' + i}.`);

  ids.question = await create('Waiting on a question');
  await say(ids.question, 'First write one short sentence saying you need a decision, then call the ask_user tool with the question "Which deployment target should I use?" and the choices ["Staging", "Production", "Both, staging first"]. Wait for my answer.', 'question');

  writeFileSync('/tmp/kraki-design-sessions.json', JSON.stringify(ids, null, 2));
  log('SESSIONS', JSON.stringify(ids));
  app.close();
  process.exit(0);
}

main().catch((e) => { console.error('[seed] FAIL', e); process.exit(1); });
