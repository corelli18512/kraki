# Native macOS automation

Kraki's Debug macOS target includes an opt-in, focus-safe semantic automation
driver. It is intended for coding agents and end-to-end development workflows
that must inspect and operate Kraki without taking over the user's desktop.

## Why this exists

Playwright controls browsers through browser-owned automation protocols. A
native AppKit/SwiftUI app has no equivalent built-in protocol. AX, XCTest, and
Appium Mac2 operate the system GUI and may activate the application, move it to
the foreground, change the key window, or disturb keyboard focus.

Kraki's driver instead calls the same application actions used by its controls:
`CommandSender`, `SessionStore`, `MessageProvider`, and small SwiftUI presenter
adapters. It does not simulate mouse or keyboard input.

## Safety contract

The driver:

- is compiled only in `DEBUG` builds;
- starts only when `KRAKI_NATIVE_AUTOMATION=1` is present at process launch;
- listens on a Unix domain socket owned by the current user with mode `0600`;
- never launches, restarts, terminates, or activates Kraki;
- never calls `NSApp.activate`, `makeKeyAndOrderFront`, AX actions, `CGEvent`,
  AppleScript, or System Events;
- never opens a file picker or another system modal;
- uses the real relay, Tentacle, stores, and command paths selected by the app's
  ordinary launch configuration.

The companion client also never starts the app. If the socket does not exist,
it exits with an error.

## Starting an automation-enabled Debug build

The environment variable must be present when Kraki starts:

```bash
KRAKI_NATIVE_AUTOMATION=1 \
KRAKI_NATIVE_AUTOMATION_SOCKET=/tmp/kraki-native-automation-$UID.sock \
"/path/to/Kraki Dev.app/Contents/MacOS/Kraki Dev"
```

The Debug product is deliberately separate from the stable app: it is named
`Kraki (Dev)`, uses bundle ID `chat.kraki.mac.dev`, and stores its defaults,
Keychain keys, SQLite data, and attachment cache outside the Prod app's domains.
Without `KRAKI_DEV_LOCAL=1` or a `KRAKI_RELAY_URL` override, it uses the CLI's
production relay login.

Starting a native GUI app can itself affect the current desktop. For unattended
validation, start it in a dedicated macOS VM or ask the user to start it. Once
the socket is available, semantic commands do not require activation.

Do not use `open`, `open -g`, `NSApp.activate`, XCTest/Appium launch commands, or
AX raise actions as part of a claimed focus-safe workflow.

## CLI

```bash
scripts/kraki-native.py ping
scripts/kraki-native.py snapshot
```

Create a real session and wait for the authoritative ID:

```bash
CREATE=$(scripts/kraki-native.py create-session \
  --device dev_example \
  --agent pi \
  --model 1yuan-gpt/gpt-5.6-sol \
  --cwd /tmp/kraki-e2e \
  --title "Simple website" \
  --prompt "Create a small static website in this directory.")

REQUEST_ID=$(printf '%s' "$CREATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["requestId"])')

scripts/kraki-native.py wait sessionCreated \
  --request-id "$REQUEST_ID" --timeout 60000
```

Wait for completion and inspect state:

```bash
scripts/kraki-native.py wait sessionIdle --session-id SESSION_ID --timeout 300000
scripts/kraki-native.py snapshot
```

Present and verify Steps without a synthetic click:

```bash
scripts/kraki-native.py present-steps SESSION_ID --seq BUBBLE_SEQ
scripts/kraki-native.py wait stepsPresented --session-id SESSION_ID --seq BUBBLE_SEQ
scripts/kraki-native.py wait stepsLoaded --session-id SESSION_ID --seq BUBBLE_SEQ
scripts/kraki-native.py close-steps
```

## Protocol

The socket uses newline-delimited JSON. One connection may carry one or more
requests. A request is:

```json
{"id":"1","method":"snapshot","params":{}}
```

A successful response is:

```json
{"id":"1","ok":true,"result":{}}
```

An error response is:

```json
{"id":"1","ok":false,"error":{"code":"timeout","message":"..."}}
```

Supported methods:

- `ping`
- `snapshot`
- `chatState`
- `chatLayout`
- `scrollProductionGate` — Debug-only seven-case scroll reliability gate covering entry, older prepend, discrete wheel controller, precise momentum/watchdog, one-page-per-gesture arming, resize anchor, and top/bottom clamping
- `pageOlder`
- `pageNewer`
- `scrollToBubble`
- `scrollChat`
- `simulateMissingLiveScrollEnd` — Debug-only scroll-settle watchdog regression hook;
  pass `overlapScrollerKnob=true` to cover a concurrent scrollbar drag
- `createSession`
- `selectSession`
- `sendInput`
- `setMode`
- `abort`
- `permission`
- `answer`
- `requestSteps`
- `presentSteps`
- `closeSteps`
- `capture`
- `wait`
- `shutdown` — stops only the automation listener, not Kraki

Supported wait conditions:

- `connected`
- `sessionCreated`
- `sessionIdle`
- `messageContains`
- `stepsLoaded`
- `stepsPresented`
- `selectedSession`

## Visual verification

Use the driver's in-process capture for an off-screen automation host:

```bash
scripts/kraki-native.py capture /tmp/kraki-chat.png
scripts/kraki-native.py capture /tmp/kraki-steps.png --sheet
```

For a normally visible, already-running Kraki instance, ScreenCaptureKit may
also capture its window by window ID. Do not activate or raise it. For generated
web content, run a local HTTP server and use headless Playwright; do not open
Safari or another foreground browser.

Semantic automation verifies the real application state and rendering path. A
test that specifically requires physical native mouse/key events must run in a
dedicated macOS VM or test Mac, because macOS does not provide headless native
window-event isolation comparable to browser contexts.

## Production Mac history diagnostics

The production Mac app writes a bounded, low-frequency Chat presentation trace
to `~/Documents/chat-entry.log` and mirrors the same records to Unified Log.
The file rotates at 512 KiB. It never records message text, attachment data,
credentials, tokens, or tool arguments/results.

Mac history records use four prefixes:

- `mac-window`: initial window selection and older/newer px-managed trimming;
- `mac-fetch`: DB/Relay pagination start, apply, stale-result, and fallback;
- `mac-page`: the window projected into the AppKit list, including seq ranges,
  visible real/placeholder/unmaterialized seqs, cache counts, warm state, offset,
  and edge state;
- `mac-watchdog`: a missing AppKit live-scroll-end callback was recovered.

After a reproduction, preserve the approximate time and Session ID/title, then
inspect only the relevant metadata lines:

```bash
tail -300 ~/Documents/chat-entry.log \
  | grep -E 'mac-(window|fetch|page|watchdog)'

log show --last 30m --style compact \
  --predicate 'subsystem == "chat.kraki.ios" AND eventMessage CONTAINS "mac-"'
```

The CLI exposes both watchdog paths without native input:

```bash
scripts/kraki-native.py simulate-missing-scroll-end
scripts/kraki-native.py simulate-missing-scroll-end --overlap-scroller-knob
```

A healthy page converges to `placeholders=[]`, `missing=[]`, `warm=0`, and
`pendingHeight=0`. `reason=viewport-stuck`, repeated page transitions with no
new user input, or a window shrinking below the Mac 15-row floor identifies the
failing layer without exposing message content.
