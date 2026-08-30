# macOS Chat Scenario Test Page

The Debug macOS app includes an isolated catalog that renders production Chat UI against synthetic protocol/store states.

## Open it

In **Kraki Dev**:

- choose **Debug → Chat Scenario Test Page**, or
- press **⌥⌘T**.

The scenario window never connects its isolated `AppState` to a Relay and never writes to a production Session. It uses a temporary GRDB database, the real `MainWindowView`, `MacChatView`, `ChatViewModel`, `TurnSpineProjection`, virtualized AppKit list, cached CoreText cells, Composer, action slots, image preview, and HTML artifact panel.

For an isolated direct launch:

```bash
KRAKI_MAC_CHAT_SCENARIO_PAGE=1 \
KRAKI_MAC_CHAT_SCENARIO_ID=question-long-choices \
KRAKI_MAC_CHAT_SCENARIO_PHASE=1 \
"/path/to/Kraki Dev.app/Contents/MacOS/Kraki Dev"
```

`KRAKI_MAC_CHAT_SCENARIO_PHASE` is one-based.

## Catalog

The sidebar enumerates 48 production-shaped cases across:

- entry, online/offline cache, and initial-head loading;
- compact and sparse-sequence history pagination, including an isolated native scroll-production gate fixture;
- live drafts, partial Markdown/code, tools, and parallel tools;
- pending and resolved Permission variants;
- choice, long-choice, free-form, answered, and cancelled Questions;
- compaction, steer input, and runtime/card coexistence;
- normal, aborted, failed, interrupted, no-reply, and duplicate terminal outcomes;
- inline images, pure-image output, lazy image refs, and secure HTML reports;
- full streaming lifecycle, reconnect snapshots, late-frame rejection;
- same- and cross-Tentacle Session switching;
- unread, human-echo, draft, pinned, and active Sidebar projections.

## Controls

The test rail above the real page provides:

- scenario selection and previous/next navigation;
- phase stepping, reset, and autoplay;
- Disconnect/Reconnect using the real subscription assurance state machine;
- same-Tentacle and cross-Tentacle rapid switching;
- pending-session starting and failed states.

Question, Permission, Composer, Abort, mode, and metadata controls still call the production `CommandSender`. A Debug-only outbound hook simulates the authoritative response locally, so those interactions exercise the real UI command path without Relay traffic.
