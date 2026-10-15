# Kraki for Mac 0.2.86

- Keep the recording glass box and its contents in sync as speech wraps, so text and controls stay inside the box throughout layout changes.
- Keep speech top-aligned in an expanded recording box, even when rearranging the buttons makes the text fit on one line again.
- Preserve an expanded new-session draft's dimensions when recording starts; longer speech grows to the editor's ten-line limit before scrolling.
- Sending voice from a new session now opens the chat immediately and continues correction in the message bubble. The agent receives the message only after session creation and voice completion are both ready.
- Preserve speech and follow-up drafts when session creation fails or times out, and recover unfinished local messages after relaunch without sending a placeholder session ID.
