# Plan: Claude Code Adapter for Kraki

## Problem

Kraki currently only supports GitHub Copilot via `CopilotAdapter`. The ROADMAP lists Claude Code adapter as a P1 priority. Users who use Claude Code as their coding agent need a `ClaudeAdapter` so their sessions can be remotely controlled through Kraki's E2E-encrypted relay.

## Approach

Build a `ClaudeAdapter` that wraps the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) and implements the existing `AgentAdapter` interface. The SDK provides a `query()` function that returns an async generator of `SDKMessage` objects — we consume that stream and map each message type to the appropriate `on*` adapter callback.

The Claude Agent SDK is structurally different from the Copilot SDK:
- **Copilot SDK**: imperative — `createSession()`, `session.send()`, event emitters
- **Claude Agent SDK**: streaming generator — `query(prompt, options)` yields `SDKMessage` objects; permissions via `canUseTool` callback; questions via `AskUserQuestion` tool detection

The adapter must bridge this difference while keeping the `AgentAdapter` interface unchanged.

## Key design decisions

### Authentication
- Claude Agent SDK uses `ANTHROPIC_API_KEY` (or Bedrock/Vertex env vars)
- Unlike Copilot (which uses GitHub token for both relay auth and SDK auth), the Claude API key is **only** for the SDK — relay auth remains GitHub-based
- The adapter should check `ANTHROPIC_API_KEY` on `start()` and fail early if missing

### Permission mapping
Kraki's 4-mode permission system maps onto the Claude Agent SDK's permission modes + `canUseTool` callback:

| Kraki Mode | Claude SDK Approach |
|------------|-------------------|
| **safe** | `permissionMode: 'default'` + `canUseTool` blocks on every tool |
| **discuss** | `permissionMode: 'default'` + `canUseTool` auto-approves reads, blocks writes (except plan.md), blocks shell |
| **execute** | `permissionMode: 'bypassPermissions'` (or `acceptEdits` + allowed tools) |
| **delegate** | `permissionMode: 'bypassPermissions'` + auto-answer questions |

More precisely: use `permissionMode: 'default'` for safe/discuss, with the `canUseTool` callback implementing the same logic as `makePermissionHandler()` in copilot.ts. For execute/delegate, switch to `bypassPermissions`.

The SDK supports `query.setPermissionMode()` for mid-session mode changes (streaming input mode).

### Session model
- Claude Agent SDK sessions persist to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
- Resume via `resume: sessionId` option on `query()`
- Fork via `forkSession: true` + `resume: sourceSessionId`
- `continue: true` resumes the most recent session (not needed — we track IDs explicitly)

### Streaming input for multi-turn
- The SDK's `query()` with an `AsyncIterable<SDKUserMessage>` as the prompt enables streaming input mode
- This allows `send()` calls mid-session and `setPermissionMode()` changes
- This is the right approach for Kraki since sessions are long-lived and interactive

### System prompt
- Use `systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT }` to keep Claude Code's built-in prompt and append Kraki's mode instructions
- Same `SYSTEM_PROMPT` content as the Copilot adapter (mode descriptions, mode-switch signal)

### Tool events
- `SDKAssistantMessage` with tool_use content blocks → `onToolStart`
- Tool results in the stream → `onToolComplete`
- `SDKAssistantMessage` with text content → `onMessage` / `onMessageDelta`
- `SDKResultMessage` → `onIdle` (turn complete)

### Questions (AskUserQuestion)
- Detected in `canUseTool` when `toolName === 'AskUserQuestion'`
- Bridge to `onQuestionRequest` callback with blocking Promise pattern (same as Copilot adapter)

### Model listing
- `query.supportedModels()` returns available models after initialization
- Map to `listModels()` / `listModelDetails()`

## Todos

1. **add-claude-dependency** — Add `@anthropic-ai/claude-agent-sdk` as a dependency to `packages/tentacle/package.json`

2. **claude-adapter-core** — Create `packages/tentacle/src/adapters/claude.ts` implementing `AgentAdapter`:
   - `start()` / `stop()` — validate API key, initialize state
   - `createSession()` — start `query()` with streaming input, wire message consumer loop
   - `resumeSession()` — use `resume: sessionId` option
   - `forkSession()` — use `resume: sourceId` + `forkSession: true`
   - `sendMessage()` — push to streaming input async iterable
   - `killSession()` — call `query.close()` or abort controller
   - `abortSession()` — call `query.interrupt()`
   - `listSessions()` — use SDK's `listSessions()` function
   - `setSessionMode()` — call `query.setPermissionMode()` + store pending mode signal
   - `setSessionModel()` — call `query.setModel()`
   - `listModels()` / `listModelDetails()` — from initialization result
   - `generateTitle()` — use the SDK or a separate query

3. **claude-permission-handler** — Implement `canUseTool` callback:
   - Map Kraki permission modes to SDK approval logic
   - Handle `AskUserQuestion` tool → bridge to `onQuestionRequest`
   - Always-allow session-scoped sets (same pattern as Copilot adapter)
   - Blocking Promise pattern for relay round-trip

4. **claude-message-consumer** — Implement the async message consumer loop:
   - `SDKAssistantMessage` → parse content blocks (text → `onMessage`, tool_use → `onToolStart`)
   - `SDKResultMessage` → `onIdle`, extract session ID, capture usage
   - `SDKPartialAssistantMessage` → `onMessageDelta` (requires `includePartialMessages: true`)
   - `SDKSystemMessage` → capture session ID, models
   - Error messages → `onError`
   - Tool results → `onToolComplete`

5. **claude-adapter-export** — Update `packages/tentacle/src/adapters/index.ts` to export `ClaudeAdapter`

6. **daemon-worker-claude** — Update `daemon-worker.ts` to support selecting between Copilot and Claude adapters:
   - Add adapter selection to config (e.g., `agent: 'copilot' | 'claude'`)
   - Instantiate the right adapter based on config
   - Handle Claude-specific auth (API key instead of GitHub token for SDK)

7. **cli-claude-setup** — Update CLI setup flow (`setup.ts`) to ask which agent to use and configure accordingly:
   - Prompt for agent choice (Copilot / Claude Code)
   - For Claude: prompt for API key or check `ANTHROPIC_API_KEY`
   - Store agent choice in config

8. **config-claude** — Update `config.ts` to support `agent` field and Claude-specific config (API key path)

9. **parse-permission-claude** — Extend `parse-permission.ts` to handle Claude SDK tool names:
   - Claude tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, etc.
   - Map to existing Kraki `ToolArgs` types (`ShellToolArgs`, `ReadFileToolArgs`, `WriteFileToolArgs`, etc.)

10. **claude-adapter-tests** — Add tests for the Claude adapter:
    - Unit tests mirroring `packages/tentacle/src/__tests__/copilot.test.ts` patterns
    - Permission handler logic tests
    - Message consumer mapping tests

11. **protocol-agent-field** — Verify/update the protocol's `agent` field to accept `'claude'` in addition to `'copilot'` in session messages. Check if it's a free string or an enum.

12. **arm-claude-display** — Update arm/web to display Claude sessions appropriately:
    - Agent avatar / icon for Claude sessions
    - Model names display (claude-sonnet-4, etc.)
    - Any Claude-specific UI considerations

## Notes

- The Claude Agent SDK is a drop-in npm package (`@anthropic-ai/claude-agent-sdk`) — no separate CLI binary needed (unlike Copilot which requires `copilot` on PATH)
- The SDK handles its own API communication — no need for a local server process
- Session persistence is handled by the SDK itself to `~/.claude/projects/`
- The system prompt approach is nearly identical to Copilot (append mode)
- The biggest structural difference is the streaming generator pattern vs event emitters — the message consumer loop is the core integration challenge
- MCP server support is built into the Claude Agent SDK via `mcpServers` option (same config shape)
- Usage tracking: `SDKAssistantMessage.message.usage` provides token counts per turn
