// Drive one real subagent turn per agent against the LOCAL stack (port 4480).
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectApp, sendToTentacle, subscribeApp, tentacleTarget, waitMs } from '../../packages/tests/src/helpers.ts';

const PORT = Number(process.env.PORT ?? 4480);
const hint: Record<string, string> = {
  claude: 'your Agent tool (subagent_type general-purpose)',
  copilot: 'your task tool (a subagent)',
  codex: 'a spawned sub-agent (spawn_agent)',
  pi: 'the `subagent` tool with agent "scout"',
};
const prompt = (a: string) => [
  `Use ${hint[a]} to delegate this search to ONE subagent. Do NOT read, list or grep any files yourself.`,
  'Task for the subagent: "Find which file under the current directory contains a line with CODEWORD and report the file path and the codeword."',
  'When the subagent returns, reply with exactly one line: `<path>: <codeword>`.',
].join('\n');

async function main() {
  const agents = (process.argv[2] ?? 'claude,copilot,codex,pi').split(',');
  const app = await connectApp(PORT, 'Subagent Shots');
  const t = tentacleTarget(app);
  const { existsSync, readFileSync } = await import('node:fs');
  const outFile = process.env.SHOT_OUT ?? '/tmp/subagent-shots/sessions.json';
  const out: Record<string, string> = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};
  await Promise.all(agents.map(async (agent) => {
    const ws = `/tmp/subagent-shots/ws-${agent}`;
    mkdirSync(`${ws}/src/deep`, { recursive: true });
    writeFileSync(`${ws}/README.md`, '# demo\n');
    writeFileSync(`${ws}/src/a.ts`, 'export const a = 1;\n');
    writeFileSync(`${ws}/src/deep/config.ts`, '// CODEWORD: purple-otter-42\nexport const cfg = {};\n');
    const requestId = `shot-${agent}-${Date.now()}`;
    sendToTentacle(app, { type: 'create_session', deviceId: app.deviceId, seq: 0, timestamp: new Date().toISOString(),
      payload: { requestId, targetDeviceId: t.id, agentId: agent, model: process.env[`MODEL_${agent.toUpperCase()}`] ?? '', cwd: ws } });
    let created: any;
    for (let i = 0; i < 240 && !created; i++) {
      created = app.messages.find((m: any) => m.type === 'session_created' && m.payload?.requestId === requestId);
      if (!created) await waitMs(250);
    }
    if (!created) throw new Error(`${agent}: no session_created`);
    const sessionId = created.sessionId as string;
    out[agent] = sessionId;
    console.log(agent, 'session', sessionId);
    await subscribeApp(app, sessionId);
    sendToTentacle(app, { type: 'send_input', sessionId, deviceId: app.deviceId, seq: 0, timestamp: new Date().toISOString(),
      payload: { clientId: `c-${agent}-${Date.now()}`, text: process.env.SHOT_PROMPT ?? prompt(agent) } });
    for (let i = 0; i < 720; i++) {
      await waitMs(500);
      const idle = app.messages.find((m: any) => m.sessionId === sessionId && m.type === 'idle');
      if (idle) break;
    }
    const reply = app.messages.filter((m: any) => m.sessionId === sessionId && m.type === 'agent_message').map((m: any) => m.payload?.content).at(-1);
    console.log(agent, 'idle; reply:', JSON.stringify(reply));
  }));
  writeFileSync(process.env.SHOT_OUT ?? '/tmp/subagent-shots/sessions.json', JSON.stringify(out, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
