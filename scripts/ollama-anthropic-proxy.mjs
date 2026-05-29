/**
 * Tiny Anthropic Messages API → Ollama proxy.
 *
 * Translates /v1/messages requests into Ollama /api/chat format.
 * Just enough to let the Claude Agent SDK talk to a local model.
 *
 * Usage: node scripts/ollama-anthropic-proxy.mjs [--port 4010] [--model llama3.2:3b]
 */

import { createServer } from 'node:http';

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '4010', 10);
const MODEL = process.argv.find((_, i, a) => a[i - 1] === '--model') ?? 'llama3.2:3b';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';

function translateMessages(anthropicMessages) {
  return anthropicMessages.map(m => {
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
  });
}

async function handleMessages(req, res, body) {
  const { messages, system, stream } = body;

  const ollamaMessages = [];
  if (system) {
    const sysText = typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : '';
    if (sysText) ollamaMessages.push({ role: 'system', content: sysText });
  }
  ollamaMessages.push(...translateMessages(messages ?? []));

  const ollamaReq = {
    model: MODEL,
    messages: ollamaMessages,
    stream: !!stream,
  };

  const ollamaRes = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ollamaReq),
  });

  if (!ollamaRes.ok) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'api_error', message: `Ollama error: ${ollamaRes.status}` } }));
    return;
  }

  const msgId = `msg_${Date.now()}`;

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // message_start
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', model: MODEL,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })}\n\n`);

    // content_block_start
    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    })}\n\n`);

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalOutput = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.content) {
            totalOutput++;
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta', index: 0,
              delta: { type: 'text_delta', text: chunk.message.content },
            })}\n\n`);
          }
        } catch { /* skip malformed lines */ }
      }
    }

    // content_block_stop
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);

    // message_delta
    res.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: totalOutput },
    })}\n\n`);

    // message_stop
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    res.end();
  } else {
    // Non-streaming
    const ollamaBody = await ollamaRes.json();
    const text = ollamaBody.message?.content ?? '';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: msgId, type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: text.split(/\s+/).length, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
  }
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Collect body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();
  let body = {};
  try { body = JSON.parse(rawBody); } catch { /* empty */ }

  const url = req.url ?? '/';

  if (url.includes('/v1/messages')) {
    try {
      await handleMessages(req, res, body);
    } catch (err) {
      console.error('Proxy error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
    }
  } else if (url.includes('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-20250514', display_name: `Ollama ${MODEL} (local)` }],
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: MODEL }));
  }
});

server.listen(PORT, () => {
  console.log(`🦙 Anthropic→Ollama proxy on http://localhost:${PORT} (model: ${MODEL})`);
});
