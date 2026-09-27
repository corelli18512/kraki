# Windows Codex fresh-install E2E — 2026-09-27

## Scope and isolation

- Windows 10, PowerShell 5.1, Node 23.6.1, Codex CLI 0.157.1.
- Removed the old Kraki installation after backing up its state/task; kept other agents and the user's Codex configuration. The user completed Codex login before model tests.
- Tested the published Windows installer and npm `@kraki/tentacle@0.33.1` first, then an unpublished package built from this PR.
- Fresh Kraki identity + fresh browser profile + separate local Head/database. Windows reached that Head through a loopback-only SSH reverse tunnel. No production Kraki account, relay, or daemon was used or restarted.
- Real Web client, real Windows daemon, real `codex app-server`; model `gpt-6-luna`, reasoning effort `low` throughout model-driven Windows tests.
- This is **not** a validation of hosted GitHub signup/OAuth/region routing. Pairing used the self-hosted flow and an isolated local identity. The patched standalone SEA is covered by CI; interactive live-agent runs used the npm test package.

## Defects reproduced and fixed

| Defect | Reproduction | Fix |
| --- | --- | --- |
| Installer selects a Mac-only release | `/releases/latest` returned `mac-v0.2.40-diag`, without a Windows CLI asset. The script constructed an invalid download URL. | Select a non-draft, non-prerelease release that contains the Windows asset; paginate and fail clearly if none exists. Keep root/public scripts identical and ASCII-safe: English Windows PowerShell 5.1 CI also caught the old UTF-8 checkmark decoding to a quote and breaking parsing. |
| npm daemon loses the Windows PATH | Spreading `process.env` preserved `Path`, but `cleanEnv.PATH` was undefined. Adding a second `PATH` passed only `.bin` to the child. Runtime could not discover Codex. | Merge case-insensitive path keys into one `PATH` before spawning. |
| Codex's POSIX npm shim selected on Windows | `where codex` lists the extensionless shell script before `codex.cmd`. Spawning that first entry independently reproduced `ENOENT`. | Preserve executable PATH order but skip non-Windows-launchable entries. |
| Wizard/doctor omit Codex | Published wizard only offered Copilot/Claude; self-hosted SEA setup required Copilot. | Shared Codex-aware discovery in both setup routes and Codex CLI/version in doctor. |
| Replies completed offline are permanently lost | Disconnect the Windows-to-Head tunnel while a command runs. Final reply and idle were absent from `messages.jsonl`, even after reload. | Persist durable messages before the network guard. Drop only offline live deltas; reconnect recovers history from the existing local spine, not a new event queue. |
| Windows shim path containing spaces fails | A `.cmd` RPC fixture in `Codex bin with spaces` exited before initialize. | Quote shell-launched `.cmd`/`.bat` paths; do not use a shell for native executables or Unix paths. |

The correct published `v0.33.1` Windows binary also downloaded successfully on Windows and matched its published SHA256SUMS entry. This verifies download selection, **not** that the currently published binary contains these fixes.

## Real end-to-end results

| Scenario | Result / evidence |
| --- | --- |
| Clean setup, detect/select Codex, daemon readiness | Pass after fixes; Codex 0.157.1 detected and seven models advertised. |
| CLI pairing link → fresh Web client | Pass; new device/session, no reused Kraki identity. |
| Chinese prompt, streaming/final response, automatic title | Pass. |
| Select model and low effort | Pass; persisted Codex sidecar confirms model/effort. |
| Safe command approval | Pass; file absent before approval, expected bytes afterwards. |
| Deny command | Pass; target remains absent and no retry. |
| Allow in Session | Pass; two separate commands complete after one grant. |
| Cross-session approval isolation | Pass; a grant in session A does not suppress session B's approval. |
| `ask_user` choice / free text | Pass; selected blue and a mixed Chinese/space answer return correctly. |
| Delegate question handling | Pass; automatic answer, no blocking question card. |
| Image upload → vision → `show_image` | Pass; text, red square and blue circle recognized; both images rendered at 640×360, including after reload. |
| Stop a running command | Pass; background command terminated; delayed write still absent beyond its original deadline. |
| Stop while waiting for permission / question | Pass; no delayed write or stuck prompt, subsequent message works. |
| Steer a running turn | Pass; final answer follows the interruption, not the original requested marker. |
| Daemon restart + context | Pass; original test phrase and selected color recalled. |
| Tunnel loss during a turn | Failed before fix; passed after fix with final reply recovered automatically. |
| Browser reload and history | Pass; messages/images restored without page errors. |
| Fork session | Pass; fork retains history and native Codex context. |
| `apply_patch` in an explicit project directory | Pass after approval, including a Chinese/spaced project path and UTF-8 content. **Project cwd was supplied through the Web client's existing command API**, not a UI field. |
| Small coding task | Files created by Codex. Tests failed in a Chinese directory due to the independent Node issue below; the exact same files passed in an ASCII directory (`TESTS_PASS_927`, exit 0), also confirmed through the client. |
| Final PR package startup/resume | Pass; final live round recalled prior context and returned `FINAL_WINDOWS_OK_927`. |

## Known limitations — not silently worked around in product code

1. **Web has no working-directory field.** New sessions default to `/` (the Windows drive root). Approved `apply_patch` writes failed from the root and user-home contexts, and the same failures reproduced with a standalone native Codex app-server. The native baseline and Kraki both succeeded with the concrete test project as cwd. A user-home-default experiment did not fix this and was reverted. No sandbox or trust settings were changed. A project-directory selection UX remains a follow-up; default Web onboarding is not claimed fully green.
2. **Existing Windows Node 23.6.1 crashes on a relative module load in the tested Chinese directory.** `calc.test.cjs` required `./calc.cjs` and exited with `0xC0000005` outside Kraki as well. Exact files copied to an ASCII directory passed. A single-file Chinese-path script and an ASCII-path `node:assert/strict` script passed independently. Node was not upgraded or replaced. This is an environment/path-specific finding, not a claimed Codex adapter fix.
3. Closing an SSH session can terminate its Windows job's children. Persistent daemon testing used an isolated interactive scheduled task rather than treating an SSH-launched process's lifetime as desktop behavior.

## Regression coverage / repeatable commands

- Full workspace `pnpm validate` with isolated `HOME` and **unset** inherited `KRAKI_HOME` (one pre-existing test intentionally asserts the default `.kraki` location).
- Real Codex adapter integration suite: four tests passed (additional local native-protocol coverage, not a substitute for Windows E2E).
- `powershell -NoProfile -File scripts/e2e/windows-installer.test.ps1`: published-copy parity, PowerShell 5.1 ASCII safety, Mac/prerelease skipping, pagination, missing-asset failure; no network or installer execution in this test.
- After building tentacle, `node scripts/e2e/windows-codex-shim.mjs`: real `.cmd` and `.bat` launches in a spaced Windows path using a local JSON-RPC fixture; no Codex login/model invocation.
- Added unit regressions for Windows PATH preservation, executable selection, Codex discovery/setup, and durable final reply + idle with absent/closed sockets.
- Windows installer/shim checks are part of the existing Windows CI binary-daemon job. Native clients are unchanged.

## Review boundaries

- No release/version bump, production deployment, credential migration, sandbox widening, or default working-directory change.
- Existing reconnect replay remains the recovery authority; no unbounded offline message queue.
- Installer and shared relay changes are deliberately included because they blocked the real fresh-user Windows scenario, rather than being attributed to Codex protocol code.
