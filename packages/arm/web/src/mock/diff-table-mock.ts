import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { encryptToBlob, importPublicKey, generateKeyPair, exportPublicKey, decryptFromBlob } from '../../../../crypto/src/index.js';

const PORT = 9000;
const wss = new WebSocketServer({ port: PORT });

// Generate a key pair for the mock tentacle
const tentacleKeys = generateKeyPair();
const tentaclePubKeyCompact = exportPublicKey(tentacleKeys.publicKey);

let globalSeq = 0;
const nextSeq = () => ++globalSeq;

const SESSION_ID = 'sess-demo';

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function sendEncrypted(ws, clientDeviceId, clientPubKey, innerMsg) {
  if (!clientPubKey) {
    // No E2E key — send as plain JSON (fallback)
    send(ws, JSON.stringify(innerMsg));
    return;
  }
  const plaintext = JSON.stringify(innerMsg);
  const pubKey = importPublicKey(clientPubKey);
  const { blob, keys } = encryptToBlob(plaintext, [
    { deviceId: clientDeviceId, publicKey: pubKey },
  ]);
  send(ws, JSON.stringify({ type: 'unicast', to: clientDeviceId, blob, keys }));
}

function innerEnvelope(type, sessionId, payload) {
  return {
    type,
    deviceId: 'dev-tentacle',
    seq: nextSeq(),
    timestamp: new Date().toISOString(),
    ...(sessionId && { sessionId }),
    payload,
  };
}

wss.on('connection', (ws) => {
  let clientDeviceId = '';
  let clientPubKey = null;
  console.log('[mock] Client connected');

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    console.log('[mock] Received:', msg.type);
    switch (msg.type) {
      case 'auth_info':
        send(ws, JSON.stringify({ type: 'auth_info_response', authModes: ['open'], e2e: false, pairing: true }));
        break;
      case 'auth': {
        clientDeviceId = msg.device?.deviceId || ('dev-web-' + randomUUID().slice(0, 8));
        clientPubKey = msg.device?.encryptionKey || msg.device?.publicKey || null;
        console.log('[mock] Auth device:', clientDeviceId, 'pubKey:', clientPubKey ? 'yes' : 'no');
        send(ws, JSON.stringify({
          type: 'auth_ok',
          deviceId: clientDeviceId,
          authMethod: 'token',
          user: { id: 'user-1', login: 'demo', provider: 'open' },
          devices: [
            { id: 'dev-tentacle', name: 'MacBook Pro', role: 'tentacle', kind: 'desktop', online: true, encryptionKey: tentaclePubKeyCompact },
            { id: clientDeviceId, name: 'Web Browser', role: 'app', kind: 'web', online: true },
          ],
          relayVersion: '0.3.0',
        }));
        // Simulate tentacle sending session_list after device_joined
        setTimeout(() => {
          const sessionListMsg = innerEnvelope('session_list', undefined, {
            sessions: [{
              id: SESSION_ID,
              agent: 'copilot',
              model: 'gpt-4o',
              title: 'Demo Session',
              state: 'active',
              lastSeq: 0,
              readSeq: 0,
              messageCount: 0,
              createdAt: new Date().toISOString(),
            }],
          });
          sendEncrypted(ws, clientDeviceId, clientPubKey, sessionListMsg);
          console.log('[mock] Sent session_list');
        }, 200);
        break;
      }
      case 'ping':
        send(ws, JSON.stringify({ type: 'pong' }));
        break;
      case 'request_session_replay':
        sendEncrypted(ws, clientDeviceId, clientPubKey,
          innerEnvelope('session_replay_complete', msg.sessionId, {}));
        break;
      case 'unicast':
      case 'broadcast': {
        // Decrypt incoming encrypted message from app
        try {
          const plaintext = decryptFromBlob(
            { blob: msg.blob, keys: msg.keys },
            'dev-tentacle',
            tentacleKeys.privateKey,
          );
          const inner = JSON.parse(plaintext);
          console.log('[mock] Decrypted:', inner.type);
          if (inner.type === 'send_input') {
            const text = inner.payload?.text ?? '';
            console.log('[mock] User input:', text);
            sendEncrypted(ws, clientDeviceId, clientPubKey,
              innerEnvelope('user_message', SESSION_ID, { content: text }));
            simulateResponse(ws, clientDeviceId, clientPubKey);
          }
        } catch (err) {
          console.log('[mock] Decrypt failed:', err.message);
        }
        break;
      }
      default:
        // Handle plaintext consumer messages (approve, send_input, etc.)
        if (msg.type === 'send_input' || msg.payload?.text) {
          const text = msg.payload?.text ?? '';
          console.log('[mock] User input:', text);
          sendEncrypted(ws, clientDeviceId, clientPubKey,
            innerEnvelope('user_message', SESSION_ID, { content: text }));
          simulateResponse(ws, clientDeviceId, clientPubKey);
        }
        break;
    }
  });
});

function simulateResponse(ws, clientDeviceId, clientPubKey) {
  const enc = (msg) => sendEncrypted(ws, clientDeviceId, clientPubKey, msg);

  // 1. Agent message with a large table
  setTimeout(() => {
    enc(innerEnvelope('agent_message', SESSION_ID, {
      content: `Here's a comprehensive comparison of popular web frameworks:

| Category | Framework | Language | Stars | License | Version | Maintainer | First Release | Weekly Downloads | Bundle Size | TypeScript | SSR | Status |
|----------|-----------|----------|-------|---------|---------|------------|---------------|-----------------|-------------|------------|-----|--------|
| Frontend | React | JavaScript | 220k | MIT | 19.0 | Meta | 2013 | 24M | 42kb | ✅ | ✅ | Active |
| Frontend | Vue | JavaScript | 207k | MIT | 3.4 | Evan You | 2014 | 4.5M | 33kb | ✅ | ✅ | Active |
| Frontend | Angular | TypeScript | 95k | MIT | 17.0 | Google | 2016 | 3.2M | 130kb | ✅ | ✅ | Active |
| Frontend | Svelte | JavaScript | 78k | MIT | 5.0 | Vercel | 2016 | 800k | 2kb | ✅ | ✅ | Active |
| Frontend | Solid | TypeScript | 32k | MIT | 1.8 | Ryan Carniato | 2018 | 120k | 7kb | ✅ | ✅ | Active |
| Frontend | Preact | JavaScript | 36k | MIT | 10.0 | Jason Miller | 2015 | 2.1M | 3kb | ✅ | ✅ | Active |
| Backend | Express | JavaScript | 64k | MIT | 4.18 | OpenJS | 2010 | 30M | — | ❌ | — | Active |
| Backend | Fastify | JavaScript | 32k | MIT | 4.28 | NearForm | 2016 | 2.8M | — | ✅ | — | Active |
| Backend | Django | Python | 81k | BSD | 5.0 | Django SF | 2005 | — | — | — | — | Active |
| Backend | Rails | Ruby | 56k | MIT | 7.1 | Basecamp | 2004 | — | — | — | — | Active |
| Backend | Laravel | PHP | 78k | MIT | 11.0 | Taylor Otwell | 2011 | — | — | — | — | Active |
| Backend | Spring Boot | Java | 74k | Apache 2.0 | 3.2 | VMware | 2014 | — | — | — | — | Active |
| Backend | Gin | Go | 79k | MIT | 1.10 | Community | 2014 | — | — | — | — | Active |
| Backend | Actix | Rust | 21k | MIT | 4.6 | Community | 2017 | — | — | — | — | Active |
| Fullstack | Next.js | JavaScript | 125k | MIT | 14.2 | Vercel | 2016 | 6.5M | — | ✅ | ✅ | Active |
| Fullstack | Nuxt | JavaScript | 54k | MIT | 3.12 | NuxtLabs | 2016 | 700k | — | ✅ | ✅ | Active |
| Fullstack | Remix | TypeScript | 29k | MIT | 2.9 | Shopify | 2021 | 350k | — | ✅ | ✅ | Active |
| Fullstack | SvelteKit | JavaScript | 18k | MIT | 2.5 | Vercel | 2020 | 300k | — | ✅ | ✅ | Active |
| Fullstack | Astro | JavaScript | 45k | MIT | 4.8 | Astro | 2021 | 450k | 0kb | ✅ | ✅ | Active |
| Mobile | React Native | JavaScript | 118k | MIT | 0.74 | Meta | 2015 | 2.1M | — | ✅ | — | Active |
| Mobile | Flutter | Dart | 163k | BSD | 3.22 | Google | 2017 | — | — | — | — | Active |
| Mobile | Ionic | TypeScript | 51k | MIT | 8.0 | Ionic | 2013 | 200k | — | ✅ | — | Active |

Now let me refactor the authentication module:`,
    }));
  }, 500);

  // 2. Tool start - complex multi-line edit
  const toolCallId = 'tc-' + Date.now();
  setTimeout(() => {
    enc(innerEnvelope('tool_start', SESSION_ID, {
      toolCallId,
      toolName: 'edit',
      args: {
        path: 'src/auth/service.ts',
        old_str: `import { hash } from 'bcrypt';
import { db } from '../database';

export class AuthService {
  async login(email: string, password: string) {
    const user = await db.users.findOne({ email });
    if (!user) throw new Error('User not found');

    const valid = await compare(password, user.passwordHash);
    if (!valid) throw new Error('Invalid password');

    return { token: signJwt({ userId: user.id }), user };
  }

  async register(email: string, password: string, name: string) {
    const exists = await db.users.findOne({ email });
    if (exists) throw new Error('Email already registered');

    const passwordHash = await hash(password, 10);
    const user = await db.users.create({ email, passwordHash, name });
    return { token: signJwt({ userId: user.id }), user };
  }
}`,
        new_str: `import { hash, compare } from 'bcrypt';
import { db } from '../database';
import { signJwt, verifyJwt } from '../jwt';
import { RateLimiter } from '../rate-limiter';
import { logger } from '../logger';

const loginLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });

export class AuthService {
  async login(email: string, password: string, ip: string) {
    // Rate limiting
    if (loginLimiter.isLimited(ip)) {
      logger.warn('Login rate limited', { email, ip });
      throw new AuthError('TOO_MANY_ATTEMPTS', 'Too many login attempts. Try again later.');
    }

    const user = await db.users.findOne({ email });
    if (!user) {
      loginLimiter.record(ip);
      throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const valid = await compare(password, user.passwordHash);
    if (!valid) {
      loginLimiter.record(ip);
      throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    loginLimiter.reset(ip);
    logger.info('User logged in', { userId: user.id, email });

    const accessToken = signJwt({ userId: user.id, role: user.role }, '15m');
    const refreshToken = signJwt({ userId: user.id, type: 'refresh' }, '7d');
    await db.refreshTokens.create({ userId: user.id, token: refreshToken, expiresAt: new Date(Date.now() + 7 * 86400000) });

    return { accessToken, refreshToken, user: this.sanitizeUser(user) };
  }

  async register(email: string, password: string, name: string) {
    const exists = await db.users.findOne({ email });
    if (exists) throw new AuthError('EMAIL_EXISTS', 'Email already registered');

    if (password.length < 8) throw new AuthError('WEAK_PASSWORD', 'Password must be at least 8 characters');

    const passwordHash = await hash(password, 12);
    const user = await db.users.create({ email, passwordHash, name, role: 'user' });
    logger.info('User registered', { userId: user.id, email });

    const accessToken = signJwt({ userId: user.id, role: user.role }, '15m');
    const refreshToken = signJwt({ userId: user.id, type: 'refresh' }, '7d');
    await db.refreshTokens.create({ userId: user.id, token: refreshToken, expiresAt: new Date(Date.now() + 7 * 86400000) });

    return { accessToken, refreshToken, user: this.sanitizeUser(user) };
  }

  async refreshAccessToken(refreshToken: string) {
    const payload = verifyJwt(refreshToken);
    if (!payload || payload.type !== 'refresh') {
      throw new AuthError('INVALID_TOKEN', 'Invalid refresh token');
    }

    const stored = await db.refreshTokens.findOne({ token: refreshToken, userId: payload.userId });
    if (!stored || stored.expiresAt < new Date()) {
      throw new AuthError('EXPIRED_TOKEN', 'Refresh token expired');
    }

    const user = await db.users.findById(payload.userId);
    if (!user) throw new AuthError('USER_NOT_FOUND', 'User no longer exists');

    return { accessToken: signJwt({ userId: user.id, role: user.role }, '15m') };
  }

  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) {
      await db.refreshTokens.deleteOne({ token: refreshToken, userId });
    } else {
      await db.refreshTokens.deleteMany({ userId });
    }
    logger.info('User logged out', { userId });
  }

  private sanitizeUser(user: any) {
    const { passwordHash, ...safe } = user;
    return safe;
  }
}

class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}`,
      },
    }));
  }, 1500);

  // 3. Tool complete
  setTimeout(() => {
    enc(innerEnvelope('tool_complete', SESSION_ID, {
      toolCallId,
      toolName: 'edit',
      args: { path: 'src/auth/service.ts' },
      result: 'File edited successfully.',
    }));
  }, 2500);

  // 4. Final message
  setTimeout(() => {
    enc(innerEnvelope('agent_message', SESSION_ID, {
      content: 'Done! The auth service now includes rate limiting, refresh tokens, proper error handling, and logging.',
    }));
  }, 3000);
}

console.log(`\n  ◈ Kraki diff/table mock server on ws://localhost:${PORT}\n`);
console.log('  Send any message to get a table + code diff response.\n');
