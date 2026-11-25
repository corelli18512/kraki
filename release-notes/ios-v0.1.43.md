# Kraki for iPhone 0.1.43

- Pairing: a pairing link that opens Kraki from scratch now lands signed in, and a link for a different account no longer switches accounts or mixes their sessions without asking. Scan QR Code stays available while Kraki connects in the background, and pairing has a Cancel button and gives up after 30 s.
- Logging out stops notifications for that account on this iPhone, resets the theme, and the "Log out?" alert lists undelivered messages, unsent drafts and sessions still working.
- Notifications turn on when you allow them later in iOS Settings, and the switch follows the permission.
- Reconnecting no longer hides an open question's answers, switches the message box to Steer or shows "Jump to latest" by mistake. Coming back to Kraki checks a stale connection within 5 seconds; "Reconnecting" shows from the first launch; same-server redirects of a self-hosted relay work.
- Replies that finished while Kraki was in the background no longer vanish and slide back in. Scrolling through older history no longer jumps or snaps back to the bottom, ↓ reaches the newest message, and a chat opens at the first unread message.
- A message your computer could not take (full disk, or refused by device trust, for example because a clock is off) shows **Not delivered** with the reason and Retry. Creating or copying a session that fails says why.
- Questions: your answer is no longer held back behind the running turn, and a lost answer can be retried. A question the agent withdrew closes at once; multi-select questions say that several answers can be typed.
- The Steps sheet shows loading, "No steps recorded" or "Try again" instead of spinning forever. Very long tool output and code blocks stay smooth while a reply streams; links in your own messages are readable.
- Removing a computer removes its sessions, unread counts and cached messages from this iPhone. A session deleted elsewhere closes its page, also in another tab. Rename and Remove wait for a connection instead of failing silently.
- New Session: the + tab is there on iOS versions before 26 too. The sheet picks a computer that comes online while it is open, opens the new chat once the keyboard is gone, and fits in landscape; Back keeps working after a slow copy.
- Titles: clearing a title works, and an unchanged title is no longer saved as a manual one. Archive After reaches every computer on the account.
- Security: a revoked connection explains how to reset or scan again; clock problems say "check the clock".
- VoiceOver announces connection changes and reads drafts as "Draft"; larger text sizes no longer cut off card times or buttons; Reduce Motion is respected; times follow your 12/24-hour setting; total cost shows a plain "$"; agent notices such as "Turn failed" are shown in your language.
- Devices point out an agent that is older than the version Kraki has been tested with.
