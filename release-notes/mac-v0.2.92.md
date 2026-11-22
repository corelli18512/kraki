# Kraki for Mac 0.2.92

- Simplified Chinese: Kraki now follows your system language, or choose one in Settings › General.
- Rename any of your devices from Devices; the new name shows on every device.
- Dictation lowers other sounds while you speak (the start sound stays at full volume), and the two-row dictation box lines up with the controls next to it.
- The message box was reworked: typing a long draft no longer lags, Chinese and other input methods clear and send correctly, Undo/Redo work, quotes and dashes stay plain, and focus stays where you expect. Drop or paste an image to attach it; when it can't be added, Kraki says why.
- A message your computer could not take (full disk, or refused by device trust, for example because a clock is off) shows **Not delivered** with the reason; click it to retry or delete. A question the agent withdrew closes at once, and multi-select questions say that several answers can be typed.
- Chat: opens at the first unread message, ↓ and Send from deep history reach the newest message, history loads over the direct connection to this Mac while the relay is unreachable, a reply no longer disappears while the connection switches between the two, and Page Up/Down and the arrow keys keep scrolling.
- Switching to another GitHub account moves this Mac's built-in Kraki to that account; the old account's sessions are set aside, never shown to the new one. Renaming your GitHub account counts as such a switch: phones have to pair again.
- Only one Kraki runs per Mac account; opening a second copy brings the running one forward. The "Computer Key Changed" warning now also shows on the Mac.
- Background service: if it never starts, Kraki says "Kraki didn't start on this Mac" instead of showing offline forever; quitting offline keeps it off; it restarts once per update, not on every launch.
- Reconnects are faster: a refused connection is retried within seconds, also after sleep or a network change. The menu bar shows "Reconnecting" when Kraki cannot reach the relay, and its status row opens Settings › This Mac.
- First setup keeps its window until this Mac is online, offers to connect your phone only on a Mac that runs agents, and shows "Start Using Kraki" once your phone joins. Show Sign-in Window no longer cancels a GitHub sign-in in progress.
- Window: below a narrow chat column the Inspector folds away first, then the sidebar, and turning one back on makes room; ⌘N always starts a new session; the sidebar keeps its place when sessions reorder and the connection notice no longer covers the last row.
- Session Info: Rename… edits on first open, and Done or Esc saves the title. Changing the model keeps the Thinking level when the new model supports it. Times follow your 12/24-hour setting, and total cost shows a plain "$".
- Settings › Reconnect and "Run agents with" ask first while sessions are running on this Mac.
- Sign-in errors, agent notices such as "Turn failed" and "Stopped", and table labels are shown in your language; "Relaunch Now" explains when it cannot relaunch.
- Built-in Kraki 0.39.0: every change in [Kraki CLI 0.39.0](https://github.com/corelli18512/kraki/releases/tag/v0.39.0). After this update, going back to an older Kraki for Mac makes paired apps wait once for about 10–25 minutes.
