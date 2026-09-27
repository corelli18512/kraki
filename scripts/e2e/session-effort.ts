// Isolated local Head + real Pi adapter for native client effort-only changes.
// No prompt/LLM request is sent. Never launches/stops the installed daemon.
// See docs/session-card-effort-testing.md for the native UI gates.
import { mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function main() {
  const home = process.env.KRAKI_HOME && resolve(process.env.KRAKI_HOME);
  if (!home || home === join(homedir(), '.kraki') || process.env.KRAKI_META_FILE) {
    throw new Error('Require isolated KRAKI_HOME and unset KRAKI_META_FILE');
  }
  // Permit only a logger-only directory from an interrupted setup.
  if (existsSync(home) && readdirSync(home).some(name => name !== 'logs')) {
    throw new Error(`Use a NEW empty directory: ${home}`);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });

  // Validate isolation BEFORE imports initialize any log/state paths.
  const { PiAdapter } = await import('../../packages/tentacle/src/adapters/pi.js');
  const { SessionManager, RelayClient, KeyManager } = await import('../../packages/tentacle/src/index.js');
  const { createTestEnv, connectApp, sendToTentacle, waitMs } = await import('../../packages/tests/src/helpers.js');
  const pi = process.env.E2E_PI ?? execFileSync('/usr/bin/which', ['pi'], { encoding: 'utf8' }).trim();
  const adapter = new PiAdapter({ cliPath: pi });
  await adapter.start();
  const details = await adapter.listModelDetails();
  const chosen = details.find(d => d.id === process.env.E2E_MODEL)
    ?? details.find(d => /gpt/.test(d.id) && d.supportedReasoningEfforts?.includes('low') && d.supportedReasoningEfforts?.includes('high'));
  if (!chosen?.supportedReasoningEfforts?.includes('low') || !chosen.supportedReasoningEfforts.includes('high')) {
    throw new Error('No installed Pi model with low/high effort');
  }
  const env = await createTestEnv();
  const manager = new SessionManager();
  const relay = new RelayClient(adapter, manager, {
    relayUrl: `ws://127.0.0.1:${env.port}`, authMethod: 'open',
    device: {
      name: 'Effort Test Mac', role: 'tentacle', kind: 'desktop', deviceId: 'dev_effort_e2e',
      capabilities: { agents: [{ id: 'pi', type: 'code', models: [chosen.id], modelDetails: [chosen] }] },
    },
  }, new KeyManager());
  await new Promise<void>(resolve => { relay.onAuthenticated = () => resolve(); relay.connect(); });
  const observer = await connectApp(env.port, 'Effort E2E Observer');
  sendToTentacle(observer, {
    type: 'create_session', deviceId: observer.deviceId, seq: 0, timestamp: new Date().toISOString(),
    payload: { requestId: 'effort-e2e', targetDeviceId: 'dev_effort_e2e', agentId: 'pi', model: chosen.id, reasoningEffort: 'high', cwd: home },
  });
  const created = await observer.waitFor('session_created', 30_000);
  const sessionId = created.sessionId as string;
  sendToTentacle(observer, {
    type: 'rename_session', sessionId, deviceId: observer.deviceId, seq: 0, timestamp: new Date().toISOString(),
    payload: { title: 'Effort Sync E2E' },
  });
  await waitMs(500);
  writeFileSync(join(home, 'ready.json'), JSON.stringify({ port: env.port, sessionId, model: chosen.id, supported: chosen.supportedReasoningEfforts }, null, 2));
  console.log('READY', env.port, sessionId, chosen.id);
  const timer = setInterval(() => {
    const acknowledgements = observer.messages.filter(m => m.type === 'session_model_set' && m.sessionId === sessionId);
    let runtime: unknown;
    try { runtime = JSON.parse(readFileSync(join(home, 'sessions', sessionId, '.pi-adapter.json'), 'utf8')); } catch { /* not yet */ }
    writeFileSync(join(home, 'state.json'), JSON.stringify({ acknowledgements, metadata: manager.getMeta(sessionId), runtime }, null, 2));
  }, 250);
  async function stop() {
    clearInterval(timer);
    observer.close();
    relay.disconnect();
    await adapter.stop();
    await env.cleanup();
    process.exit(0);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch(error => { console.error(error); process.exit(1); });
