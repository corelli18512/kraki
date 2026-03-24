/**
 * Mock WebSocket server — simulates a Kraki head relay for development.
 * Run: pnpm --filter @kraki/arm-web mock
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { createLogger } from '../lib/logger';

const PORT = 9000;
const wss = new WebSocketServer({ port: PORT });
const logger = createLogger('mock');

// --- State ---

interface MockSession {
  id: string;
  deviceId: string;
  deviceName: string;
  agent: string;
  model?: string;
  state: 'active' | 'idle' | 'ended';
  messageCount: number;
}

const devices = [
  { id: 'dev-macbook', name: 'MacBook Pro', role: 'tentacle' as const, kind: 'desktop' as const, online: true, capabilities: { models: ['claude-sonnet-4', 'claude-opus-4', 'gpt-4.1', 'gpt-4o', 'o3'] } },
  { id: 'dev-server', name: 'CI Server', role: 'tentacle' as const, kind: 'server' as const, online: true, capabilities: { models: ['claude-sonnet-4', 'gpt-4.1'] } },
];

const sessions: MockSession[] = [
  { id: 'sess-1', deviceId: 'dev-macbook', deviceName: 'MacBook Pro', agent: 'copilot', model: 'gpt-4o', state: 'active', messageCount: 5 },
  { id: 'sess-2', deviceId: 'dev-server', deviceName: 'CI Server', agent: 'claude', model: 'claude-4-sonnet', state: 'idle', messageCount: 12 },
  { id: 'sess-3', deviceId: 'dev-macbook', deviceName: 'MacBook Pro', agent: 'codex', state: 'ended', messageCount: 3 },
];

let globalSeq = 100;
const nextSeq = () => ++globalSeq;

// --- Helpers ---

function envelope(type: string, sessionId: string, payload: Record<string, unknown>, deviceId = 'dev-macbook') {
  return JSON.stringify({
    type,
    deviceId,
    seq: nextSeq(),
    timestamp: new Date().toISOString(),
    sessionId,
    payload,
  });
}

function send(ws: WebSocket, data: string) {
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

// --- Connection handling ---

wss.on('connection', (ws) => {
  let clientDeviceId = '';
  logger.info('Client connected');

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleClientMessage(ws, msg);
    } catch {
      // ignore
    }
  });

  ws.on('close', () => {
    logger.info('Client disconnected');
  });

  function handleClientMessage(ws: WebSocket, msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'auth': {
        clientDeviceId = 'dev-web-' + randomUUID().slice(0, 8);
        const appDevice = {
          id: clientDeviceId,
          name: (msg.device as Record<string, unknown>)?.name ?? 'Web Browser',
          role: 'app',
          kind: 'web',
          online: true,
        };

        send(ws, JSON.stringify({
          type: 'auth_ok',
          deviceId: clientDeviceId,
          authMethod: 'open',
          user: { id: 'user-mock', login: 'mock-user', provider: 'open' },
          devices: [...devices, appDevice],
        }));

        // Send history for active sessions
        sendSessionHistory(ws);

        // Start simulation after a brief delay
        setTimeout(() => startSimulation(ws), 2000);
        break;
      }

      case 'send_input':
        logger.info(`User input in ${msg.sessionId}: ${(msg.payload as Record<string, unknown>)?.text}`);
        // Echo as user_message then simulate agent response
        send(ws, envelope('user_message', msg.sessionId as string, {
          content: (msg.payload as Record<string, unknown>)?.text ?? '',
        }));
        simulateAgentResponse(ws, msg.sessionId as string);
        break;

      case 'approve':
        logger.info(`Approved: ${(msg.payload as Record<string, unknown>)?.permissionId}`);
        send(ws, envelope('approve', msg.sessionId as string, msg.payload as Record<string, unknown>, clientDeviceId));
        // Continue with tool complete
        setTimeout(() => {
          send(ws, envelope('tool_complete', msg.sessionId as string, {
            toolName: 'shell',
            args: { command: 'echo "done"' },
            result: 'done\n',
          }));
        }, 1000);
        break;

      case 'deny':
        logger.info(`Denied: ${(msg.payload as Record<string, unknown>)?.permissionId}`);
        send(ws, envelope('deny', msg.sessionId as string, msg.payload as Record<string, unknown>, clientDeviceId));
        break;

      case 'always_allow':
        logger.info(`Always allowed: ${(msg.payload as Record<string, unknown>)?.permissionId}`);
        send(ws, envelope('always_allow', msg.sessionId as string, msg.payload as Record<string, unknown>, clientDeviceId));
        break;

      case 'answer':
        logger.info(`Answer: ${(msg.payload as Record<string, unknown>)?.answer}`);
        send(ws, envelope('answer', msg.sessionId as string, msg.payload as Record<string, unknown>, clientDeviceId));
        break;

      case 'kill_session':
        logger.info(`Kill session: ${msg.sessionId}`);
        send(ws, envelope('session_ended', msg.sessionId as string, { reason: 'killed by user' }));
        break;
    }
  }
});

// --- Send initial session history ---

function sendSessionHistory(ws: WebSocket) {
  // Session 1 (copilot) — diverse tool call history
  send(ws, envelope('session_created', 'sess-1', { agent: 'copilot', model: 'gpt-4o' }));
  send(ws, envelope('user_message', 'sess-1', { content: 'Help me refactor the authentication module' }));
  send(ws, envelope('agent_message', 'sess-1', {
    content: "I'll help you refactor the authentication module. Let me start by reading the current implementation.",
  }));

  // Tool: read_file
  send(ws, envelope('tool_start', 'sess-1', { toolCallId: 'tc-1', toolName: 'read_file', args: { path: 'src/auth.ts' } }));
  send(ws, envelope('tool_complete', 'sess-1', {
    toolCallId: 'tc-1',
    toolName: 'read_file',
    args: { path: 'src/auth.ts' },
    result: 'export class AuthService {\n  async login(email: string, password: string) {\n    // TODO: implement\n  }\n}',
  }));

  // Tool: edit
  send(ws, envelope('tool_start', 'sess-1', { toolCallId: 'tc-2', toolName: 'edit', args: { path: 'src/auth.ts', old_str: '// TODO: implement', new_str: 'const hash = await bcrypt.hash(password, 10);\n    return this.db.insert({ email, hash });' } }));
  send(ws, envelope('tool_complete', 'sess-1', {
    toolCallId: 'tc-2',
    toolName: 'edit',
    args: { path: 'src/auth.ts', old_str: '// TODO: implement', new_str: 'const hash = await bcrypt.hash(password, 10);\n    return this.db.insert({ email, hash });' },
    result: 'File edited successfully.',
  }));

  // Tool: bash
  send(ws, envelope('tool_start', 'sess-1', { toolCallId: 'tc-3', toolName: 'bash', args: { command: 'npm test -- --grep "auth"' } }));
  send(ws, envelope('tool_complete', 'sess-1', {
    toolCallId: 'tc-3',
    toolName: 'bash',
    args: { command: 'npm test -- --grep "auth"' },
    result: 'PASS src/auth.test.ts\n  AuthService\n    ✓ login creates user (12ms)\n    ✓ login hashes password (8ms)\n\nTest Suites: 1 passed, 1 total\nTests:       2 passed, 2 total',
  }));

  // Tool: grep
  send(ws, envelope('tool_start', 'sess-1', { toolCallId: 'tc-4', toolName: 'grep', args: { pattern: 'bcrypt', path: 'src/' } }));
  send(ws, envelope('tool_complete', 'sess-1', {
    toolCallId: 'tc-4',
    toolName: 'grep',
    args: { pattern: 'bcrypt', path: 'src/' },
    result: 'src/auth.ts:2:import bcrypt from "bcrypt";\nsrc/auth.ts:5:    const hash = await bcrypt.hash(password, 10);',
  }));

  // Tool: create
  send(ws, envelope('tool_start', 'sess-1', { toolCallId: 'tc-5', toolName: 'create', args: { path: 'src/auth.test.ts', file_text: 'import { AuthService } from "./auth";\n\ntest("login", async () => {\n  const svc = new AuthService();\n  await svc.login("test@example.com", "pw");\n});' } }));
  send(ws, envelope('tool_complete', 'sess-1', {
    toolCallId: 'tc-5',
    toolName: 'create',
    args: { path: 'src/auth.test.ts' },
    result: 'File created.',
  }));

  // Tool: glob
  send(ws, envelope('tool_start', 'sess-1', { toolCallId: 'tc-6', toolName: 'glob', args: { pattern: 'src/**/*.test.ts' } }));
  send(ws, envelope('tool_complete', 'sess-1', {
    toolCallId: 'tc-6',
    toolName: 'glob',
    args: { pattern: 'src/**/*.test.ts' },
    result: 'src/auth.test.ts\nsrc/cache.test.ts\nsrc/middleware.test.ts',
  }));

  send(ws, envelope('agent_message', 'sess-1', {
    content: "Done! I've refactored the auth module, added bcrypt hashing, and all tests pass. ✅",
  }));

  // Session 2 (claude) — idle session
  send(ws, envelope('session_created', 'sess-2', { agent: 'claude', model: 'claude-4-sonnet' }, 'dev-server'));
  send(ws, envelope('agent_message', 'sess-2', {
    content: 'The CI pipeline analysis is complete. All tests are passing. Here are the metrics:\n\n- **Build time**: 2m 34s (↓ 15%)\n- **Test coverage**: 87.3% (↑ 2.1%)\n- **Bundle size**: 142KB gzipped',
  }, 'dev-server'));

  // Session 3 (codex) — ended
  send(ws, envelope('session_created', 'sess-3', { agent: 'codex' }));
  send(ws, envelope('agent_message', 'sess-3', { content: 'Generated the database migration files successfully.' }));
  send(ws, envelope('session_ended', 'sess-3', { reason: 'completed' }));
}

// --- Simulation scenarios ---

function startSimulation(ws: WebSocket) {
  // Scenario 1: After 3s, agent sends a streaming message
  setTimeout(() => {
    const chunks = [
      "I've analyzed ",
      "the codebase and found ",
      "a potential memory leak in ",
      "`src/cache.ts`. ",
      "The `WeakMap` reference isn't being ",
      "properly cleaned up when connections close.\n\n",
      "Let me fix that now…",
    ];
    let delay = 0;
    for (const chunk of chunks) {
      setTimeout(() => {
        send(ws, envelope('agent_message_delta', 'sess-1', { content: chunk }));
      }, delay);
      delay += 150 + Math.random() * 200;
    }
    // Final complete message
    setTimeout(() => {
      send(ws, envelope('agent_message', 'sess-1', {
        content: "I've analyzed the codebase and found a potential memory leak in `src/cache.ts`. The `WeakMap` reference isn't being properly cleaned up when connections close.\n\nLet me fix that now…",
      }));
    }, delay + 100);
  }, 3000);

  // Scenario 2: After 6s, a permission request
  setTimeout(() => {
    const permId = 'perm-' + randomUUID().slice(0, 8);
    send(ws, envelope('tool_start', 'sess-1', {
      toolName: 'shell',
      args: { command: 'npm install --save-dev @types/node@latest' },
    }));
    send(ws, envelope('permission', 'sess-1', {
      id: permId,
      toolName: 'shell',
      args: { command: 'npm install --save-dev @types/node@latest' },
      description: 'Install updated TypeScript Node.js type definitions',
    }));
  }, 8000);

  // Scenario 3: After 12s, a question
  setTimeout(() => {
    const qId = 'q-' + randomUUID().slice(0, 8);
    send(ws, envelope('question', 'sess-1', {
      id: qId,
      question: 'Which database driver should I use for the migration?',
      choices: ['better-sqlite3', 'pg (PostgreSQL)', 'mysql2'],
    }));
  }, 14000);

  // Scenario 4: After 18s, new session appears
  setTimeout(() => {
    const newSessId = 'sess-' + randomUUID().slice(0, 8);
    send(ws, JSON.stringify({
      type: 'head_notice',
      event: 'session_updated',
      data: {
        session: {
          id: newSessId,
          deviceId: 'dev-server',
          deviceName: 'CI Server',
          agent: 'claude',
          model: 'claude-4-opus',
          state: 'active',
          messageCount: 0,
        },
      },
    }));
    send(ws, envelope('session_created', newSessId, { agent: 'claude', model: 'claude-4-opus' }, 'dev-server'));
    setTimeout(() => {
      send(ws, envelope('agent_message', newSessId, {
        content: '🔍 Starting deep code review of PR #142: "Refactor auth middleware"\n\nI\'ll check for:\n- Security vulnerabilities\n- Performance regressions\n- API compatibility breaks',
      }, 'dev-server'));
    }, 1500);
  }, 20000);

  // Scenario 5: After 25s, simulate a device joining and later leaving
  setTimeout(() => {
    const newDevId = 'dev-tablet-' + randomUUID().slice(0, 4);
    send(ws, JSON.stringify({
      type: 'device_joined',
      device: { id: newDevId, name: 'iPad Pro', role: 'app', kind: 'tablet', online: true },
    }));
    setTimeout(() => {
      send(ws, JSON.stringify({ type: 'device_left', deviceId: newDevId }));
    }, 5000);
  }, 25000);
}

// --- Agent response simulation ---

function simulateAgentResponse(ws: WebSocket, sessionId: string) {
  const responses = [
    "That's a great question! Let me think about the best approach here.\n\nBased on the current architecture, I'd recommend using a **middleware pattern** to handle this cleanly. Here's what I'm thinking:\n\n```typescript\nconst authMiddleware = (req, res, next) => {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).json({ error: 'Unauthorized' });\n  // validate token\n  next();\n};\n```",
    "Done! I've made the following changes:\n\n1. Updated `src/auth.ts` — Added token refresh logic\n2. Modified `src/middleware.ts` — Integrated rate limiter\n3. Created `src/auth.test.ts` — Added 12 new test cases\n\nAll tests are passing ✅",
    "I found an issue with the current approach. The session store is using synchronous I/O which could block the event loop under heavy load.\n\nWould you like me to refactor it to use async/await?",
  ];

  const response = responses[Math.floor(Math.random() * responses.length)];

  // Simulate streaming
  let delay = 500;
  const words = response.split(/(?<=\s)/);
  let accumulated = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    setTimeout(() => {
      send(ws, envelope('agent_message_delta', sessionId, { content: word }));
    }, delay);
    accumulated += word;
    delay += 30 + Math.random() * 60;
  }

  // Final complete message
  setTimeout(() => {
    send(ws, envelope('agent_message', sessionId, { content: accumulated }));
  }, delay + 100);
}

logger.info(`\n  ◈ Kraki mock server running on ws://localhost:${PORT}\n`);
logger.info('  Simulating:');
logger.info('    • 2 machines (MacBook Pro, CI Server)');
logger.info('    • 3 sessions (Copilot, Claude, Codex)');
logger.info('    • Streaming messages, permissions, questions');
logger.info('    • New session after ~20s\n');
logger.info('  Start the web app: pnpm --filter @kraki/arm-web dev\n');
