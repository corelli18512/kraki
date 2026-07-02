// Anthropic Messages API  <->  Copilot (OpenAI chat/completions) translation.
//
// Two directions:
//   toOpenAIRequest(anthropicBody)  — request shape translation
//   streamAnthropicFromOpenAI(...)  — stateful OpenAI SSE -> Anthropic SSE
//   buildAnthropicMessage(...)      — non-streaming OpenAI -> Anthropic JSON

let idCounter = 0;
const genId = (p) => `${p}_${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function textFromBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
}

/** Map Anthropic thinking config (or a forced default) to a Copilot reasoning_effort. */
function reasoningEffort(body) {
  const forced = process.env.COPILOT_FORCE_EFFORT; // e.g. "high"
  if (forced) return forced;
  const t = body.thinking;
  if (t && t.type === 'enabled') {
    const b = t.budget_tokens || 0;
    if (b >= 16000) return 'high';
    if (b >= 4000) return 'medium';
    return 'low';
  }
  // Default: full power. The whole point of this proxy is 满血 reasoning.
  return 'high';
}

/** Anthropic request body -> OpenAI chat/completions request body. */
export function toOpenAIRequest(body, model) {
  const messages = [];

  // system: string or array of text blocks
  if (body.system) {
    const sys = textFromBlocks(body.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }

  for (const msg of body.messages || []) {
    const role = msg.role;
    const content = msg.content;

    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const b of content) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
        // thinking blocks are dropped on the way back in (Copilot has no
        // thinking-input channel); the model re-reasons each turn.
      }
      const m = { role: 'assistant' };
      m.content = textParts.join('') || null;
      if (toolCalls.length) m.tool_calls = toolCalls;
      messages.push(m);
      continue;
    }

    // role === 'user' (or tool results carried on a user turn)
    const userParts = [];
    for (const b of content) {
      if (b.type === 'text') {
        userParts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        userParts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        });
      } else if (b.type === 'tool_result') {
        // OpenAI requires tool results as their own role:tool messages.
        let c = b.content;
        if (Array.isArray(c)) c = c.map((x) => (x?.type === 'text' ? x.text : '')).join('');
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(c ?? '') });
      }
    }
    if (userParts.length) {
      // collapse to a plain string when it's only text (wider compatibility)
      const onlyText = userParts.every((p) => p.type === 'text');
      messages.push({
        role: 'user',
        content: onlyText ? userParts.map((p) => p.text).join('') : userParts,
      });
    }
  }

  const out = {
    model,
    messages,
    max_tokens: body.max_tokens ?? 32000,
    stream: body.stream !== false,
  };
  if (out.stream) out.stream_options = { include_usage: true };
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  out.reasoning_effort = reasoningEffort(body);

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === 'auto') out.tool_choice = 'auto';
      else if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'tool' && tc.name) {
        out.tool_choice = { type: 'function', function: { name: tc.name } };
      }
    }
  }
  return out;
}

const STOP_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
  function_call: 'tool_use',
};

/**
 * Consume an OpenAI SSE ReadableStream (web stream of Uint8Array) and yield
 * Anthropic SSE event strings ("event: ...\ndata: ...\n\n").
 *
 * Handles three block types in Anthropic order: thinking -> text -> tool_use.
 */
export async function* streamAnthropicFromOpenAI(openaiBody, model) {
  const enc = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const msgId = genId('msg');

  yield enc('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  yield enc('ping', { type: 'ping' });

  let blockIndex = -1;
  let openType = null; // 'thinking' | 'text' | 'tool_use'
  let sigBuf = '';
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };
  // openai tool_call index -> anthropic block index
  const toolBlocks = new Map();

  function* closeOpen() {
    if (openType === null) return;
    if (openType === 'thinking' && sigBuf) {
      yield enc('content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'signature_delta', signature: sigBuf },
      });
    }
    yield enc('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openType = null;
    sigBuf = '';
  }

  function* openBlock(type, contentBlock) {
    yield* closeOpen();
    blockIndex += 1;
    openType = type;
    yield enc('content_block_start', {
      type: 'content_block_start', index: blockIndex, content_block: contentBlock,
    });
    return blockIndex;
  }

  const reader = openaiBody.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }

        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
            output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
            cache_read_input_tokens: cached,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        // 1) reasoning / thinking
        if (delta.reasoning_text) {
          if (openType !== 'thinking') {
            yield* openBlock('thinking', { type: 'thinking', thinking: '' });
          }
          yield enc('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_text },
          });
        }
        if (delta.reasoning_opaque) sigBuf += delta.reasoning_opaque;

        // 2) assistant text
        if (delta.content) {
          if (openType !== 'text') {
            yield* openBlock('text', { type: 'text', text: '' });
          }
          yield enc('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'text_delta', text: delta.content },
          });
        }

        // 3) tool calls
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const oaIdx = tc.index ?? 0;
            if (!toolBlocks.has(oaIdx)) {
              yield* openBlock('tool_use', {
                type: 'tool_use',
                id: tc.id || genId('toolu'),
                name: tc.function?.name || '',
                input: {},
              });
              toolBlocks.set(oaIdx, blockIndex);
            }
            const arg = tc.function?.arguments;
            if (arg) {
              yield enc('content_block_delta', {
                type: 'content_block_delta', index: toolBlocks.get(oaIdx),
                delta: { type: 'input_json_delta', partial_json: arg },
              });
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = STOP_MAP[choice.finish_reason] || 'end_turn';
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  yield* closeOpen();
  yield enc('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
  });
  yield enc('message_stop', { type: 'message_stop' });
}

/** Non-streaming: OpenAI completion JSON -> Anthropic message JSON. */
export function buildAnthropicMessage(openaiJson, model) {
  const choice = openaiJson.choices?.[0] || {};
  const m = choice.message || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const tc of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* keep {} */ }
    content.push({ type: 'tool_use', id: tc.id || genId('toolu'), name: tc.function?.name, input });
  }
  return {
    id: genId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: openaiJson.usage?.prompt_tokens ?? 0,
      output_tokens: openaiJson.usage?.completion_tokens ?? 0,
    },
  };
}
