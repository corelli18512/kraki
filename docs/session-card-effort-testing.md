# Session card effort: native UI regression gate

The card uses **session.reasoningEffort**, not a model default or the last-used
picker preference. Unknown/unset effort stays hidden. The separate trailing
label survives model-name truncation. iOS's cell fingerprint includes it.

## Unit coverage

`SessionCardEffortTests` covers all five effort values, unset/missing model,
effort-only cell reconfiguration, acknowledgements/digest refresh, clearing,
and local Codable restoration. It runs with the ordinary `Kraki` test scheme.

## Isolated native round trip (no LLM turn)

Use a new worktree, dedicated simulator, DerivedData directories, and local test
state. Do not use `scripts/dev-local.ts`: its cleanup can stop sibling dev stacks.
Do not change, install over, or restart the production app/daemon.

1. `pnpm install --frozen-lockfile && pnpm build`.
2. Start the local Head + real Pi adapter fixture, leaving it running:

   ```sh
   env -u KRAKI_META_FILE -u KRAKI_RELAY_URL -u PI_SESSION_FILE -u PI_SESSION_ID \
     KRAKI_HOME=/tmp/kraki-effort-NEW \
     pnpm exec tsx scripts/e2e/session-effort.ts
   ```

   It discovers a local Pi model supporting low/high (optional `E2E_MODEL`),
   sends **no prompt**, and writes `ready.json` with `port`, `sessionId`, `model`.
   `state.json` records actual `session_model_set` acknowledgements, Tentacle
   session metadata, and the Pi recovery sidecar's model/thinking setting.
   SIGINT stops only this fixture and its own Pi processes.

3. Generate/build `KrakiMac` Debug under a dedicated DerivedData directory.
   Launch that built executable directly with:

   ```sh
   KRAKI_DEV_LOCAL=1 KRAKI_LOCAL_RELAY_PORT=<ready.port> \
   KRAKI_DATA_DIR=/tmp/kraki-effort-mac-NEW \
   KRAKI_NATIVE_AUTOMATION=1 KRAKI_NATIVE_AUTOMATION_VISIBLE=1 \
   KRAKI_NATIVE_AUTOMATION_SOCKET=/tmp/kraki-effort-NEW.sock \
   KRAKI_OPEN_SESSION_ID=<ready.sessionId> \
   '<DerivedData>/Build/Products/Debug/Kraki Dev.app/Contents/MacOS/Kraki Dev'
   ```

   **Visible launch is opt-in and can activate the Dev window**: ask the user
   before doing this on their desktop. The non-activating host can render the
   sidebar but its SwiftUI sheet may not materialize native controls. Never
   substitute a direct store mutation and call it a picker UI test.

4. Run the Mac gate:

   ```sh
   python3 scripts/e2e/session-effort-mac.py \
     --socket /tmp/kraki-effort-NEW.sock --state-dir /tmp/kraki-effort-NEW
   ```

   It opens the real Session Info sheet, selects low then high through the
   `NSSegmentedControl`'s native target/action (the same Picker binding), and
   checks a **new** server acknowledgement plus the card projection and Pi
   sidecar. Model must remain unchanged. Sidebar/picker PNGs and JSON proof
   are saved with the fixture. There are no OS-level mouse/focus events.

5. Build `KrakiUITests` with `CODE_SIGN_IDENTITY=-` on a dedicated simulator.
   Run `SessionEffortE2EUITests` with these xcodebuild environment variables:

   ```text
   TEST_RUNNER_KRAKI_EFFORT_SESSION=<ready.sessionId>
   TEST_RUNNER_KRAKI_EFFORT_PORT=<ready.port>
   TEST_RUNNER_KRAKI_EFFORT_MODEL=<ready.model>
   TEST_RUNNER_KRAKI_EFFORT_REMOTE_DIR=/tmp/kraki-effort-NEW
   ```

   In parallel run the Mac driver again with `--remote-ios` (leave the info
   sheet open). XCTest physically taps the iOS title/model/Low/High controls,
   dismisses the sheet, returns to the list and asserts its displayed effort.
   It then keeps the list visible and creates `ios-awaiting-remote-low`; the
   Mac driver selects Low, and XCTest checks that the **already-visible iOS
   card updates without navigation/reload**. Screenshots are retained in
   xcresult and the fixture directory. Use fresh state for repeat runs so no
   old readiness marker can satisfy this handshake.

## Workspace regression isolation

For `pnpm validate`, unset inherited `KRAKI_HOME`/`KRAKI_META_FILE` and use an
isolated temporary `HOME`. Supplying `KRAKI_HOME` to the entire suite conflicts
with the existing config test that checks the default `~/.kraki` path.

## Verified in this change

- Mac real effort Picker: high → low → high; unchanged model, new ACKs,
  corresponding card label and Pi thinking state.
- iOS real taps: high → low → high and matching card after returning to list.
- Mac → iOS: live low update while the reused iOS list cell remains on screen.
- Mac narrow sidebar: model is truncated, effort remains visible.
- No production deployment, app replacement, runtime patch, or daemon restart.
