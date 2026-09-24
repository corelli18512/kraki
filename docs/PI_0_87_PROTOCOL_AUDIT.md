# Kraki 0.31.22 × Pi 0.87.1 protocol audit

Date: 2026-09-24

## Validation snapshot — fixes prepared for v0.31.23

The reproduced adapter/extension problems were fixed and validated in an isolated branch. These fixes are included in the v0.31.23 release candidate; Claude/Copilot audit changes are excluded. At audit completion, the running signed binary was still 0.31.22. Publishing a release and updating an installed daemon are separate steps.

- Original live audit: **25/31 passed**, six failing cases below.
- Added failed-artifact coverage: both show_image/show_html returned isError=true in their result object, which Pi does not treat as a failed tool call. Converted their failure paths to throws. This is a seventh compatibility issue, covered by two additional tests.
- Fixed branch live audit: **33/33 passed** against the same actual global Pi 0.87.1 binary and loopback model server.
- Full `pnpm validate`: **passed** (lint, all workspace builds, **1710 tests**: crypto 36, head 261, tentacle 933, protocol E2E 44, web 436). Live Pi's 33 tests run separately from this total.
- Added ordinary unit regressions for LF framing, split UTF-8, partial argument escapes/surrogates, catalog Unicode, length/deferred recovery, and ordered queue clearing.
- Updated the declared workspace Pi dependency/runtime contract to 0.87.1; added explicit partial-json dependency for argument reconstruction. This does not change how production discovers the user's local Pi through PATH.
- Abort queue handling: clear only the inputs already handed to Pi, then resolve pending UI dialogs, then await abort. Relay's canonical transcript/ledger and future input chain remain intact; the active ledger is marked aborted/settled by existing Relay handling. Queue-clear errors fail visibly rather than claiming successful cancellation.
- Initial full validation could not load the native better-sqlite3 binding because this worktree was installed with scripts disabled. Reused the already-built **same-version 11.10.0 binding** from the clean release worktree, verified it with this Node runtime and an in-memory SQL query, then reran full validation successfully. No test assertions were bypassed.

Reports `fixed-live.json` and `fixed-unit.json` supplement the original before-fix reports.

## Original audit scope and result

- Kraki source: release commit `c34f5c5` (0.31.22), isolated worktree `kraki-pi087-protocol-audit`, branch `test/pi087-protocol-audit`.
- Pi: actual globally installed executable, `/Users/corelli/.nvm/versions/node/v24.14.1/bin/pi`, version **0.87.1**. The integration suite explicitly checks its version. It does NOT use the workspace's pinned Pi dependency.
- Existing tentacle unit/regression suite: **918/918 passed**. Its Pi runtime contract still checks the workspace dependency **0.84.1**; it does not establish compatibility with the globally installed runtime.
- New opt-in integration suite: **31 cases, 25 passed, 6 failed**, reproducible against the unmodified released adapter. Assertions were not weakened or marked expected-failure.
- Real child process, RPC transport, session persistence, stock Pi built-in tools, Kraki extension, permission UI round-trips and adapter callbacks. Model generation is scripted through a loopback HTTP/SSE OpenAI-compatible server, enabling repeatable failure/compaction/abort cases without external API calls.
- HOME, PI_CODING_AGENT_DIR, KRAKI_HOME and all session/filesystem artifacts are isolated. No production credentials copied, historical sessions resumed, or live daemon restarted. Production Pi/adapter code unchanged.
- Previous upgrade smoke separately verified a real GPT-6 Astra request with the Kraki extension. This audit is not a full model/provider matrix, browser/macOS UI rendering test, or relay/mobile end-to-end test.

## Passing coverage

1. Catalog discovery and reasoning levels.
2. Ordinary multilingual text streaming, prompt acceptance independent of completion, authoritative settlement and turn identity.
3. Live model/thinking switching; model and thinking restoration after process eviction.
4. Real read/write/edit/bash execution; tool callbacks and usage/cost mapping.
5. Discuss write approval and denial; safe-mode gating; live mode change without respawn; kraki_get_mode.
6. ask_user select and input, free-form text and image answer envelopes.
7. Image input normalization; show_image/show_html results into persisted attachment refs.
8. Finalize fallback returns the final reply and settles once (streaming exception below).
9. Abort active model stream, a running bash process, pending question and pending permission; a subsequent prompt works. Aborted bash does not execute its deferred write.
10. Steer queued during a tool execution, without duplicate idle.
11. Exact-file lazy resume preserves context; fork does not modify the parent transcript.
12. Transient retry; exhausted retry emits one error and permits a later prompt.
13. Manual compaction; ordinary context-overflow compaction/retry; queueing a new turn during background threshold compaction with correct turn IDs.

## Reproducible failures

### 1. High: truncated response recovery can lose the final answer

Source: `packages/tentacle/src/adapters/pi.ts:903-918,1044-1053,1296-1312`.

Real Pi sequence: assistant stopReason=length → agent_end(willRetry=false) → overflow compaction → retry → complete assistant answer → agent_settled.

Adapter treats the first agent_end as a candidate for early maintenance idle. Its early-settlement helper excludes error/aborted but not length, so compaction_start promotes the truncated prose and marks the logical turn settled. The recovered answer is then suppressed by the settled-turn guard.

Observed final callback: `TRUNCATED_NOT_FINAL`; actual successful recovered message: `LENGTH_RECOVERED`.

Fix direction: early conversational settlement must require a genuinely completed response (e.g. stopReason=stop); recovery and finalize paths must await agent_settled. Retain the existing successful background-maintenance behavior.

### 2. High: Unicode separators break RPC record framing

Source: `packages/tentacle/src/adapters/pi.ts:136,591`.

The adapter and catalog probe use Node readline. On the installed Node 24 runtime it splits U+2028/U+2029 as well as LF. Pi RPC explicitly requires LF-only JSONL framing. A valid JSON record containing these characters becomes multiple unparsable lines, which the adapter discards.

Observed input assistant text `hello\u2028world\u2029你好` disappears; the adapter wrongly injects a finalize round and returns its fallback response instead. A standalone readline reproduction also confirms the split, so this is not a model/SSE fixture issue.

Fix direction: use StringDecoder/buffered LF-only splitting, support optional CRLF, and cover both session transport and catalog query.

### 3. Medium: finalize_reply streaming assumes removed cumulative snapshots

Source: `packages/tentacle/src/adapters/pi.ts:517-530,1091-1111`.

Pi 0.87 RPC message_update records are delta-only; assistantMessageEvent.partial is intentionally absent. The adapter reads partial.content[contentIndex].arguments.text, so it never emits onFinalizeDelta.

Observed: final reply `FINAL_STREAMED_TEXT` is correct, but zero finalize text deltas are emitted. This is loss of live finalization rendering, not loss of the final reply itself.

Fix direction: reconstruct tool identity/argument deltas from toolcall_start/toolcall_delta and reconcile with toolcall_end/message_end.

### 4. Medium: tool prompt guidelines become individual characters

Source: `packages/tentacle/src/adapters/pi-kraki-tools.ts:53,116,142,188,236`.

Kraki registers promptGuidelines as a string. Installed Pi's ToolDefinition declares string[] and iterates guidelines. The actual provider system prompt contains `- U`, `- s`, `- e`, etc., instead of complete guidance sentences.

Observed via the actual outgoing HTTP request: the full ask_user guideline is absent and a list of individual characters occupies the rules section. Tools still execute, but their intended model instructions are corrupted.

Fix direction: use arrays of complete strings in each embedded tool definition; assert against the actual generated prompt.

### 5. Medium: explicit abort leaves queued follow-up input

Source: `packages/tentacle/src/adapters/pi.ts:1686-1733`; released Relay abort handling marks the turn/session idle after adapter abort.

Pi 0.87 documents clear_queue separately from abort. Adapter invokes only abort. With a held active request and one queued follow-up, abort returns with isStreaming=false but pendingMessageCount=1.

This run did NOT observe an immediate new model request after abort; the directly proven defect is residual queued work, not immediate spontaneous execution. The queue can outlive the UI's aborted/settled boundary. The intended product semantics of cancelling versus retaining queued input should be made explicit.

Fix direction for full cancellation: clear_queue before abort, reconcile returned messages with Relay input state rather than silently discarding user input.

### 6. Medium: slash-containing model IDs are truncated

Source: `packages/tentacle/src/adapters/pi.ts:773,1830`.

Catalog correctly lists `audit/org/model-c`. Adapter splits the full selection at every slash and takes only the first two parts. set_model asks for provider=audit, modelId=org and returns `Model not found: audit/org`. Spawn has the same parsing pattern.

This affects providers with namespaced model IDs; it is not specific to GPT-6 nor necessarily introduced by 0.87.

Fix direction: split at the first slash only; preserve the rest of the model ID. Test discovery → selection → spawn/resume as one contract.

## Reproduction

From `packages/tentacle`:

```sh
# Ordinary existing tests (workspace's pinned dependencies)
env -u KRAKI_HOME pnpm exec vitest run --config vitest.config.ts

# Real globally installed Pi, isolated sessions and local synthetic server
PI087_CLI=/Users/corelli/.nvm/versions/node/v24.14.1/bin/pi \
KRAKI_HOME="$(mktemp -d /tmp/kraki-pi087-logs.XXXXXX)" \
pnpm exec vitest run --config vitest.pi087.config.ts
```

Optional `PI087_EVIDENCE_DIR=/path/to/output` records synthetic requests, Pi wire events and adapter callback timelines for every test. No production data is involved.

Tests: `packages/tentacle/src/__tests__/pi087-live.integration.test.ts`.
Config: `packages/tentacle/vitest.pi087.config.ts`.
Reports: `docs/pi087-audit-results/{baseline,live}.json` (compact summaries, no raw prompts).

## Notes

- An initial PNG fixture failed normalization; it was replaced with a real PNG generated by sharp. Image tests pass after that fixture correction. This is not counted as an adapter defect.
- An initial baseline run inherited a test KRAKI_HOME and failed one configuration-path assertion. Rerunning the ordinary suite without that override passed all 918 cases. This is not counted as a product defect.
- No claim is made that all six issues were introduced by upgrading Pi. These are compatibility failures observed now in the installed release/runtime combination.
- These validated fixes target v0.31.23. Unpatched installations remain affected until upgraded to a signed release containing the changes; this audit report is not a deployment record.
- Artifact-error propagation also needed correction: a custom tool must throw for Pi to emit tool_result.isError=true; returning an isError field alone is insufficient. Both missing-image and missing-HTML cases now pass.
