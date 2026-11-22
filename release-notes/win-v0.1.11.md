# Kraki for Windows 0.1.11

- A draft of a certain length (about 115 characters at some window widths) no longer crashes Kraki, and no longer crashes it again on every start because the draft was saved. A session whose title is not plain text no longer blanks the window.
- Signing out and back in during the same run works without restarting Kraki.
- A message your computer could not take (full disk, or refused by device trust, for example because a clock is off) shows **Not delivered** with the reason and Retry. Creating or copying a session that fails says why, and a message whose images were too big to keep is not sent without them.
- Questions: a question the agent withdrew closes at once, and multi-select questions say that several answers can be typed.
- Removing a computer removes its sessions everywhere; their drafts are kept. The empty "no sessions yet" screen waits until every computer has sent its list.
- Drop an image on the message box to attach it; a file dropped anywhere else no longer opens inside Kraki.
- The first-connect dialog no longer flickers while it retries.
- Session Info keeps keyboard focus inside the panel; Send stays on screen in a narrow window; Settings › General shows "Show Account Usage" when the window is narrow.
- Devices point out an agent that is older than the version Kraki has been tested with; a Pi reply cut off at the output limit shows as a failed turn.
- Session times follow your 12/24-hour setting.
- Built-in Kraki 0.39.0: every change in [Kraki CLI 0.39.0](https://github.com/corelli18512/kraki/releases/tag/v0.39.0).
