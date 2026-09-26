// Question-flow end-to-end against the LOCAL stack only (never production):
//   KRAKI_LOCAL_RELAY_PORT=4470 KRAKI_LOCAL_WEB_PORT=3370 KRAKI_LOCAL_REDIRECT_PORT=3470 pnpm dev -- --no-open
//   pnpm exec tsx scripts/e2e/question-e2e.ts answer|abort   (protocol level)
//   scripts/e2e/run-ios.sh ui <QuestionE2EUITests test>       (iOS Simulator UI)
//   scripts/e2e/run-mac.sh ui|ui-abort|restart                (isolated Kraki Dev)
// A real Pi agent is asked to call ask_user with choices; scenarios answer by
// choice / free text, abort while asking, or restart the local daemon first.
import { connectApp, sendToTentacle, subscribeApp, tentacleTarget, waitMs } from '../../packages/tests/src/helpers.ts';

const PORT = 4470;
const log = (...a: unknown[]) => console.log('[e2e]', ...a);

async function main() {
  const app = await connectApp(PORT, 'E2E Script');
  const t = tentacleTarget(app);
  const dev = (app.authOk.devices as any[]).find((d) => d.id === t.id);
  log('tentacle', t.id, 'agents', JSON.stringify(dev?.agents ?? dev?.capabilities ?? {}).slice(0, 300));
  const models: string[] = (dev?.models?.pi ?? dev?.agentModels?.pi ?? []).map((m: any) => m.id ?? m);
  const model = process.env.E2E_MODEL ?? models.find((m) => /haiku|mini|flash/i.test(m)) ?? models[0] ?? '';
  log('model', model, 'of', models.length);

  const scenario = process.argv[2] ?? 'answer';
  const requestId = `e2e-${Date.now()}`;
  sendToTentacle(app, {
    type: 'create_session', deviceId: app.deviceId, seq: 0, timestamp: new Date().toISOString(),
    payload: { requestId, targetDeviceId: t.id, agentId: 'pi', model },
  });
  const created = await app.waitFor('session_created', 60_000);
  const sessionId = created.sessionId as string;
  log('session', sessionId);
  await subscribeApp(app, sessionId);

  const seen: Record<string, unknown>[] = [];
  const spine = () => app.messages.filter((m) => m.sessionId === sessionId && typeof m.seq === 'number'
    && ['user_message', 'agent_message', 'idle', 'turn_status', 'system_message', 'error'].includes(m.type as string));

  sendToTentacle(app, {
    type: 'send_input', sessionId, deviceId: app.deviceId, seq: 0, timestamp: new Date().toISOString(),
    payload: {
      clientId: `c1-${Date.now()}`,
      text: 'This is a test of the Kraki question flow. First write one short sentence saying you will ask a question, then call the ask_user tool with the question "Which color do you prefer?" and the choices ["Red", "Blue"]. After I answer, reply with exactly one short sentence "You prefer X." where X is my answer verbatim, and stop. Do not use any other tools.',
    },
  });

  // Wait for the question on the spine.
  let question: any;
  for (let i = 0; i < 240 && !question; i++) {
    await waitMs(500);
    question = spine().find((m) => m.type === 'agent_message' && (m.payload as any)?.question);
  }
  if (!question) throw new Error('no question landed: ' + JSON.stringify(spine().map((m) => [m.type, (m.payload as any)?.content?.slice?.(0, 60)])));
  const q = (question.payload as any).question;
  log('QUESTION seq', question.seq, 'lead:', JSON.stringify((question.payload as any).content), 'q:', JSON.stringify(q));
  const card = app.messages.filter((m) => m.sessionId === sessionId && m.type === 'card_action').map((m) => (m.payload as any)?.action?.type);
  log('card actions seen', JSON.stringify(card));

  if (scenario === 'restart') {
    const { writeFileSync, existsSync, rmSync } = await import('node:fs');
    rmSync('/tmp/kraki-e2e-restarted', { force: true });
    writeFileSync('/tmp/kraki-e2e-session', sessionId);
    log('RESTART the local daemon now');
    await waitFor(() => existsSync('/tmp/kraki-e2e-restarted'), 600_000);
    const ans = await waitFor(() => spine().find((m) => m.type === 'user_message' && (m.payload as any).answerTo === q.id), 600_000);
    log('UI ANSWER after restart', JSON.stringify((ans.payload as any).content));
    const final = await waitFor(() => spine().find((m) => m.type === 'agent_message' && !(m.payload as any).question && (m.seq as number) > (ans.seq as number)), 240_000);
    log('FINAL seq', final.seq, JSON.stringify((final.payload as any).content));
  } else if (scenario === 'ui-abort') {
    const { writeFileSync, existsSync, rmSync } = await import('node:fs');
    rmSync('/tmp/kraki-e2e-abort-go', { force: true });
    writeFileSync('/tmp/kraki-e2e-session', sessionId);
    await waitFor(() => existsSync('/tmp/kraki-e2e-abort-go'), 600_000);
    sendToTentacle(app, { type: 'abort_session', sessionId, deviceId: app.deviceId, seq: 0, timestamp: new Date().toISOString(), payload: {} });
    await waitFor(() => spine().some((m) => m.type === 'idle' && (m.seq as number) > (question.seq as number)), 60_000);
  } else if (scenario === 'ui') {
    // Hand over to a real client UI: it must answer (tap a choice).
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/kraki-e2e-session', sessionId);
    log('WAITING for a UI answer in', sessionId);
    const ans = await waitFor(() => spine().find((m) => m.type === 'user_message' && (m.payload as any).answerTo === q.id), 600_000);
    log('UI ANSWER text', JSON.stringify((ans.payload as any).content));
    log('UI ANSWER seq', ans.seq, JSON.stringify(ans.payload).slice(0, 200));
    const final = await waitFor(() => spine().find((m) => m.type === 'agent_message' && !(m.payload as any).question && (m.seq as number) > (ans.seq as number)), 180_000);
    log('FINAL seq', final.seq, JSON.stringify((final.payload as any).content));
    await waitFor(() => spine().some((m) => m.type === 'idle' && (m.seq as number) > (final.seq as number)), 60_000);
  } else if (scenario === 'abort') {
    sendToTentacle(app, { type: 'abort_session', sessionId, deviceId: app.deviceId, seq: 0, timestamp: new Date().toISOString(), payload: {} });
    await waitMs(4000);
    const after = spine().filter((m) => (m.seq as number) > (question.seq as number));
    log('AFTER ABORT', JSON.stringify(after.map((m) => [m.seq, m.type, (m.payload as any)?.reason])));
    // A late answer is an ordinary message.
    sendToTentacle(app, {
      type: 'send_input', sessionId, deviceId: app.deviceId, seq: 0, timestamp: new Date().toISOString(),
      payload: { clientId: `late-${Date.now()}`, text: 'Red', answerTo: q.id },
    });
    const late = await waitFor(() => spine().find((m) => m.type === 'user_message' && (m.payload as any).content === 'Red'));
    log('LATE ANSWER user_message answerTo =', (late.payload as any).answerTo ?? '(none)');
    await waitFor(() => spine().filter((m) => m.type === 'idle').length >= 2, 180_000);
  } else {
    const clientId = `ans-${Date.now()}`;
    sendToTentacle(app, {
      type: 'send_input', sessionId, deviceId: app.deviceId, seq: 0, timestamp: new Date().toISOString(),
      payload: { clientId, text: q.choices?.[1] ?? 'Blue', answerTo: q.id },
    });
    const ans = await waitFor(() => spine().find((m) => m.type === 'user_message' && (m.payload as any).clientId === clientId));
    log('ANSWER seq', ans.seq, JSON.stringify(ans.payload));
    const final = await waitFor(() => spine().find((m) => m.type === 'agent_message' && !(m.payload as any).question && (m.seq as number) > (ans.seq as number)), 180_000);
    log('FINAL seq', final.seq, JSON.stringify((final.payload as any).content));
    await waitFor(() => spine().some((m) => m.type === 'idle' && (m.seq as number) > (final.seq as number)), 60_000);
  }
  log('SPINE', JSON.stringify(spine().map((m) => [m.seq, m.type, (m.payload as any)?.question ? 'Q' : (m.payload as any)?.answerTo ? 'A:' + (m.payload as any).answerTo : ''])));
  log('SESSION_ID', sessionId);
  app.close();
  process.exit(0);
}

async function waitFor<T>(fn: () => T | undefined | false, timeout = 120_000): Promise<any> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = fn(); if (v) return v; await waitMs(300); }
  throw new Error('timeout');
}
main().catch((e) => { console.error('[e2e] FAIL', e); process.exit(1); });
