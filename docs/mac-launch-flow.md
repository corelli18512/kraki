# macOS Launch and Signed-Out Flow

Kraki's production Mac window uses a shared full-window entry gate before the authenticated application surface is created.

The production main scene is a single `Window(id: "main")`, not a `WindowGroup`. macOS may restore its geometry, but it cannot resurrect multiple historical main-window instances.

## User-visible contract

### Cold process launch

1. Show the Kraki launch gate immediately.
2. Resolve local CLI/stored credential availability behind the gate.
3. Keep the gate visible for at least 350 ms to avoid a one-frame flash.
4. Route to one of:
   - authenticated `MainWindowView`, landing on Welcome with no Session selected;
   - the signed-out entry gate, with `kraki connect` instructions.
5. Relay authentication and Tentacle status may continue after the authenticated shell appears. Network readiness never blocks the full-window gate indefinitely.

### Warm window reopen

When the process is still running in the menu bar, reopening the main window restores the process-local selected Session and does not replay the cold-launch gate.

### Signed out

Launch and Signed Out use the same brand shell. Signed Out replaces the launch status with:

- the `kraki connect` command and a native Copy action;
- a `Check Again` action;
- automatic credential discovery when the user returns to Kraki from Terminal;
- in-place checking/failure status.

Neither entry mode mounts Sidebar, Chat, Composer, CoreText cells, image preview, or HTML artifact state behind the gate.

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
