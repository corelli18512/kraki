# copilot-anthropic-proxy

An Anthropic-compatible (`/v1/messages`) proxy that fronts **GitHub Copilot's
Claude models**, so Kraki's `claude` SDK adapter (which embeds the Claude Code
harness via `@anthropic-ai/claude-agent-sdk`) can run **full-power,
full-reasoning `claude-opus-4.8` on a Copilot subscription** instead of the real
Anthropic API.

It reuses the `github-copilot` OAuth token that `pi` already stores in
`~/.pi/agent/auth.json`, mints short-lived Copilot API tokens, and translates
Anthropic `/v1/messages` ⇄ Copilot chat/completions (including streaming,
thinking/reasoning, and tool calls).

## Run

```bash
cd tools/copilot-proxy
npm install          # installs undici (ProxyAgent for HTTPS_PROXY geo-gating)
PORT=8788 npm start
curl -s localhost:8788/health   # {"ok":true,"model":"claude-opus-4.8"}
```

Endpoints: `POST /v1/messages` (stream + non-stream), `GET /v1/models`,
`POST /v1/messages/count_tokens`, `GET /health`.

Env: `PORT` (default 8788), `COPILOT_FORCE_EFFORT` (default `high`).

## Wire into Kraki's claude adapter

Set `KRAKI_CLAUDE_COPILOT_URL` to the proxy base URL before starting the
tentacle daemon:

```bash
export KRAKI_CLAUDE_COPILOT_URL=http://127.0.0.1:8788
```

The adapter then:

- injects the copilot `ANTHROPIC_*` env (base URL → proxy, opus-4.8 /
  sonnet-4.5 / haiku-4.5, reasoning `high`) so the auth gate passes and the
  model list shows the copilot names;
- writes a per-session shadow `settings.json` pointing at the proxy (this is the
  authoritative control point — the CLI's config-dir `settings.json` wins over
  inherited env), instead of the real `~/.claude/settings.json`.

Optional overrides: `KRAKI_CLAUDE_COPILOT_MODEL`, `KRAKI_CLAUDE_COPILOT_SONNET`,
`KRAKI_CLAUDE_COPILOT_HAIKU`.

## Notes

- Requires a valid `github-copilot` entry in `~/.pi/agent/auth.json`.
- If the environment routes egress through an `HTTPS_PROXY` (geo-gating for
  model availability), the proxy honours it via undici's `ProxyAgent`.
- Using a Copilot subscription this way may be subject to GitHub's terms; use at
  your own discretion.
