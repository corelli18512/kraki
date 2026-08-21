# macOS Launch and Signed-Out Flow

Kraki's production Mac window uses a shared full-window entry gate before the authenticated application surface is created.

The production main scene is a single `Window(id: "main")`, not a `WindowGroup`. macOS may restore its geometry, but it cannot resurrect multiple historical main-window instances.

## User-visible contract

### Cold process launch

1. Show the Kraki launch gate immediately.
2. Resolve local CLI/stored credential availability behind the gate.
3. For an authenticated launch, mount `MainWindowView` underneath the gate with no Session selected.
4. Keep Session/deep-link navigation queued while an AppKit probe completes the shell's first window-backed layout pass.
5. Keep the gate visible for at least 350 ms, then fade it after that presentation probe reports ready. A 2-second presentation watchdog is a bounded fallback if AppKit does not deliver the expected attach callback.
6. Route to one of:
   - the already-settled authenticated shell, landing on Welcome with no Session selected;
   - the signed-out entry gate, with `kraki connect` instructions.
7. Relay authentication and Tentacle status may continue after the authenticated shell appears. Network readiness never blocks the full-window gate indefinitely.

### Warm window reopen

When the process is still running in the menu bar, reopening the main window restores the process-local selected Session and does not replay the cold-launch gate.

### Signed out

Launch and Signed Out use the same brand shell. Signed Out replaces the launch status with:

- the `kraki connect` command and a native Copy action;
- a `Check Again` action;
- automatic credential discovery when the user returns to Kraki from Terminal;
- in-place checking/failure status.

Signed Out never mounts the authenticated shell. Authenticated cold launch stages only the Sidebar/Welcome shell under the launch gate so its synchronous first layout is hidden; Session navigation stays queued, therefore Chat, Composer, CoreText cells, image preview, and HTML artifact state are not mounted behind the gate.

A reconnecting `session_list` is reconciled as one SessionStore transaction and schedules one persistence snapshot. It must not invalidate the Sidebar and rebuild the full snapshot several times per Session.

## Restore policy

| State | Cold launch | Warm window reopen |
| --- | --- | --- |
| Window geometry | Restore | Restore |
| Sidebar visibility | Restore | Restore |
| Selected Session | Clear | Restore process-local selection |
| Drafts/history/unread/pinned | Preserve | Preserve |
| Preview/sheet/scroll position | Clear | Keep only while owning view remains alive |
| Connection state | Reconcile | Continue/reconnect |

## Debug visual fixtures

The Debug Mac target can render either entry state without auth or Relay traffic:

```bash
KRAKI_MAC_ENTRY_GATE_PAGE=launching "/path/to/Kraki Dev.app/Contents/MacOS/Kraki Dev"
KRAKI_MAC_ENTRY_GATE_PAGE=signed-out "/path/to/Kraki Dev.app/Contents/MacOS/Kraki Dev"
KRAKI_MAC_ENTRY_GATE_PAGE=signed-out-checking "/path/to/Kraki Dev.app/Contents/MacOS/Kraki Dev"
KRAKI_MAC_ENTRY_GATE_PAGE=signed-out-failed "/path/to/Kraki Dev.app/Contents/MacOS/Kraki Dev"
```
