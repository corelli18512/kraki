/**
 * Seed a tentacle session with 500 messages for testing pagination.
 *
 * Creates a session directory under KRAKI_HOME (default: .tmp/kraki-local)
 * with 500 varied messages. Run before `pnpm dev` to test lazy loading.
 *
 * Usage:
 *   npx tsx scripts/seed-large-session.ts          # 500 messages (default)
 *   npx tsx scripts/seed-large-session.ts 1000      # custom count
 *   npx tsx scripts/seed-large-session.ts --clean   # remove seeded session
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT_DIR = resolve(process.cwd(), '.tmp/kraki-local');
const SESSION_ID = 'sess-seed-500';
const SESSION_DIR = join(ROOT_DIR, 'sessions', SESSION_ID);
const AGENT = 'copilot';
const MODEL = 'gpt-4o';

// Handle --clean flag
if (process.argv.includes('--clean')) {
  if (existsSync(SESSION_DIR)) {
    rmSync(SESSION_DIR, { recursive: true });
    console.log(`✓ Removed seeded session: ${SESSION_ID}`);
  } else {
    console.log(`  No seeded session found at ${SESSION_DIR}`);
  }
  process.exit(0);
}

const MESSAGE_COUNT = parseInt(process.argv[2] ?? '500', 10);

// --- Message generators ---

const toolNames = ['read_file', 'edit', 'bash', 'grep', 'glob', 'create', 'view'];
const filePaths = [
  'src/auth.ts', 'src/server.ts', 'src/db.ts', 'src/middleware.ts',
  'src/routes/api.ts', 'src/models/user.ts', 'src/utils/crypto.ts',
  'tests/auth.test.ts', 'tests/api.test.ts', 'package.json',
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface MsgEntry {
  seq: number;
  type: string;
  payload: string;
  ts: string;
}

function makeTimestamp(seq: number): string {
  const base = new Date('2026-03-30T10:00:00Z');
  base.setSeconds(base.getSeconds() + seq * 2);
  return base.toISOString();
}

function generateMessages(count: number): MsgEntry[] {
  const messages: MsgEntry[] = [];
  let seq = 0;
  let toolCallCounter = 0;

  // Message 1: session_created
  seq++;
  messages.push({
    seq,
    type: 'session_created',
    payload: JSON.stringify({
      type: 'session_created',
      deviceId: 'dev-macbook',
      sessionId: SESSION_ID,
      seq,
      timestamp: makeTimestamp(seq),
      payload: { agent: AGENT, model: MODEL },
    }),
    ts: makeTimestamp(seq),
  });

  while (seq < count - 1) {
    // User message
    seq++;
    const userPrompts = [
      'Help me refactor the authentication module',
      'Can you add error handling to the API routes?',
      'Run the tests and show me the results',
      'Search for all TODO comments in the codebase',
      'Create a new migration file for the users table',
      'Fix the TypeScript errors in middleware.ts',
      'Add rate limiting to the login endpoint',
      'Review the security of the crypto utility',
    ];
    messages.push({
      seq,
      type: 'user_message',
      payload: JSON.stringify({
        type: 'user_message',
        deviceId: 'dev-macbook',
        sessionId: SESSION_ID,
        seq,
        timestamp: makeTimestamp(seq),
        payload: { content: randomFrom(userPrompts) },
      }),
      ts: makeTimestamp(seq),
    });

    if (seq >= count - 1) break;

    // Agent thinking: 2-4 tool calls per turn
    const toolCount = 2 + Math.floor(Math.random() * 3);
    for (let t = 0; t < toolCount && seq < count - 2; t++) {
      const toolCallId = `tc-${++toolCallCounter}`;
      const tool = randomFrom(toolNames);
      const file = randomFrom(filePaths);

      // tool_start
      seq++;
      messages.push({
        seq,
        type: 'tool_start',
        payload: JSON.stringify({
          type: 'tool_start',
          deviceId: 'dev-macbook',
          sessionId: SESSION_ID,
          seq,
          timestamp: makeTimestamp(seq),
          payload: { toolCallId, toolName: tool, args: { path: file, command: `cat ${file}` } },
        }),
        ts: makeTimestamp(seq),
      });

      if (seq >= count - 1) break;

      // tool_complete
      seq++;
      const results: Record<string, string> = {
        read_file: `export function handler() {\n  // implementation for ${file}\n  return { ok: true };\n}`,
        edit: 'File edited successfully.',
        bash: `$ cat ${file}\n// file contents here\n\nProcess exited with code 0`,
        grep: `${file}:12: // TODO: refactor this\n${file}:45: // TODO: add tests`,
        glob: 'src/auth.ts\nsrc/server.ts\nsrc/db.ts',
        create: 'File created successfully.',
        view: `1. import { Router } from 'express';\n2. \n3. const router = Router();\n4. // ... ${Math.floor(Math.random() * 200)} lines`,
      };
      messages.push({
        seq,
        type: 'tool_complete',
        payload: JSON.stringify({
          type: 'tool_complete',
          deviceId: 'dev-macbook',
          sessionId: SESSION_ID,
          seq,
          timestamp: makeTimestamp(seq),
          payload: { toolCallId, toolName: tool, args: { path: file }, result: results[tool] ?? 'ok' },
        }),
        ts: makeTimestamp(seq),
      });
    }

    if (seq >= count - 1) break;

    // Agent final message
    seq++;
    const agentResponses = [
      `I've completed the changes to \`${randomFrom(filePaths)}\`. All tests pass. ✅`,
      `Found 3 issues in the codebase:\n\n1. Missing error handling in API routes\n2. Unused import in middleware\n3. Deprecated bcrypt version\n\nI've fixed all three.`,
      `The refactoring is done. Here's a summary:\n\n- **Files changed**: ${2 + Math.floor(Math.random() * 5)}\n- **Lines added**: ${Math.floor(Math.random() * 100)}\n- **Lines removed**: ${Math.floor(Math.random() * 50)}\n- **Tests**: All passing`,
      `I've analyzed the code and here's what I found:\n\n\`\`\`typescript\n// The issue was here:\nconst result = await db.query(sql);\n// Should be:\nconst result = await db.query(sql, params);\n\`\`\`\n\nFixed and verified.`,
    ];
    messages.push({
      seq,
      type: 'agent_message',
      payload: JSON.stringify({
        type: 'agent_message',
        deviceId: 'dev-macbook',
        sessionId: SESSION_ID,
        seq,
        timestamp: makeTimestamp(seq),
        payload: { content: randomFrom(agentResponses) },
      }),
      ts: makeTimestamp(seq),
    });

    if (seq >= count - 1) break;

    // Idle
    seq++;
    messages.push({
      seq,
      type: 'idle',
      payload: JSON.stringify({
        type: 'idle',
        deviceId: 'dev-macbook',
        sessionId: SESSION_ID,
        seq,
        timestamp: makeTimestamp(seq),
        payload: {},
      }),
      ts: makeTimestamp(seq),
    });
  }

  return messages;
}

// --- Write session files ---

console.log(`\n  Seeding session "${SESSION_ID}" with ${MESSAGE_COUNT} messages...\n`);

mkdirSync(join(SESSION_DIR, 'runs'), { recursive: true });

const messages = generateMessages(MESSAGE_COUNT);
const lastSeq = messages[messages.length - 1].seq;

// Meta
const meta = {
  id: SESSION_ID,
  agent: AGENT,
  model: MODEL,
  title: `Seed session (${MESSAGE_COUNT} messages)`,
  state: 'idle',
  mode: 'plan',
  currentRunId: 'run_001',
  totalRuns: 1,
  lastSeq,
  readSeq: 0,
  createdAt: makeTimestamp(1),
  updatedAt: makeTimestamp(lastSeq),
};
writeFileSync(join(SESSION_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

// Run
const run = {
  id: 'run_001',
  startedAt: makeTimestamp(1),
};
writeFileSync(join(SESSION_DIR, 'runs', 'run_001.json'), JSON.stringify(run, null, 2));

// Context
writeFileSync(join(SESSION_DIR, 'context.json'), JSON.stringify({
  summary: 'Large seeded session for pagination testing',
  keyFiles: filePaths.slice(0, 3),
  lastUserMessage: 'Test message',
  updatedAt: makeTimestamp(lastSeq),
}, null, 2));

// Messages
const logContent = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
writeFileSync(join(SESSION_DIR, 'messages.jsonl'), logContent);

console.log(`  ✓ Created ${SESSION_DIR}`);
console.log(`  ✓ ${messages.length} messages (lastSeq: ${lastSeq})`);
console.log(`  ✓ Message types: session_created, user_message, tool_start, tool_complete, agent_message, idle`);
console.log(`\n  Next steps:`);
console.log(`    1. pnpm dev          # start local stack`);
console.log(`    2. Pair the web app`);
console.log(`    3. Open the "${meta.title}" session`);
console.log(`    4. Only last 50 messages should load initially`);
console.log(`    5. Scroll up to see gap markers load older messages\n`);
console.log(`  To clean up: npx tsx scripts/seed-large-session.ts --clean\n`);
