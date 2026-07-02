// Anthropic-compatible proxy in front of GitHub Copilot's Claude models.
//
// Exposes the endpoints the Anthropic SDK / Claude Code call, translates each
// request to Copilot's OpenAI-format chat/completions, and streams the reply
// back as Anthropic SSE (text + thinking + tool_use).
//
// Usage:  node server.mjs            (PORT env, default 8788)
//         COPILOT_FORCE_EFFORT=high  force reasoning effort (default: high)

import { createServer } from 'node:http';
import { getCopilotToken, COPILOT_HEADERS } from './token.mjs';
import {
  toOpenAIRequest,
  streamAnthropicFromOpenAI,
  buildAnthropicMessage,
} from './translate.mjs';

const PORT = Number(process.env.PORT || 8788);
const DEFAULT_MODEL = process.env.COPILOT_MODEL || 'claude-opus-4.8';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function log(...a) {
  if (process.env.PROXY_QUIET !== '1') console.error('[copilot-proxy]', ...a);
}

// A small, static model catalogue so the SDK's model list works.
const MODELS = [
  'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-opus-4.5',
  'claude-sonnet-4.5', 'claude-haiku-4.5',
].map((id) => ({
  type: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z',
}));

async function callCopilot(openaiBody) {
  const { token, apiBase } = await getCopilotToken();
  return fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...COPILOT_HEADERS,
    },
    body: JSON.stringify(openaiBody),
  });
}

async function handleMessages(req, res, body) {
  const anthropic = JSON.parse(body);
  const model = DEFAULT_MODEL; // pin to copilot's model id regardless of what SDK asked
  const wantStream = anthropic.stream !== false;
  const openaiBody = toOpenAIRequest(anthropic, model);
  openaiBody.stream = wantStream;

  const upstream = await callCopilot(openaiBody);

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    log('upstream error', upstream.status, errText.slice(0, 300));
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: `Copilot upstream ${upstream.status}: ${errText.slice(0, 300)}` },
    }));
    return;
  }

  if (!wantStream) {
    const j = await upstream.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildAnthropicMessage(j, model)));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  try {
    for await (const ev of streamAnthropicFromOpenAI(upstream.body, model)) {
      res.write(ev);
    }
  } catch (err) {
    log('stream error', err?.message);
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err?.message || err) } })}\n\n`);
  }
  res.end();
}

function handleCountTokens(res, body) {
  // Cheap heuristic; the SDK only needs a ballpark for context budgeting.
  const approx = Math.ceil(body.length / 4);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: approx }));
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url || '';
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: DEFAULT_MODEL }));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: MODELS, has_more: false, first_id: MODELS[0].id, last_id: MODELS.at(-1).id }));
      return;
    }
    if (req.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
      handleCountTokens(res, await readBody(req));
      return;
    }
    if (req.method === 'POST' && url.startsWith('/v1/messages')) {
      await handleMessages(req, res, await readBody(req));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `No route ${req.method} ${url}` } }));
  } catch (err) {
    log('handler error', err?.stack || err?.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err?.message || err) } }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}  (model=${DEFAULT_MODEL})`);
});
