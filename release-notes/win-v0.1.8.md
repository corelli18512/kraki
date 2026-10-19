# Kraki for Windows 0.1.8

Windows 10/11 x64 preview, including Kraki CLI 0.38.10. Conversations now behave like Kraki for Mac in many more situations.

**Conversation**
- A finished reply no longer reappears when late text or tool activity arrives.
- A message that failed to send stays where you sent it.
- When you steer, what the agent already wrote stays above your message and what follows appears below it.
- After you approve or deny, a late update can no longer show the request as waiting again.
- Steps stays on the turn you opened, even when a new turn starts.

**Reconnecting and history**
- After reconnecting, the live reply waits until the conversation has caught up, and never stays hidden if catching up fails.
- Messages always appear in order, missing history is filled in, and a history load that fails shows Retry instead of an empty conversation.
- Leaving a conversation while it loads, or deleting it, can no longer bring old data back.

**Scrolling**
- Following new text no longer fights ↑, ↓ or sending; scrolling up a little stops following.
- What you are reading stays put while older messages load; ↑ finds the previous reply even when it has to load first.
- New messages animate in again in long conversations; catching up after reconnecting no longer flashes ↓ or marks replies unseen.

**Reports and performance data**
- Report previews run in a stricter sandbox; Open in Browser exports the original file.
- Share Performance Data now also covers voice input, how quickly replies start and stream, and moments when the app is busy.

This preview installer is still not Authenticode-signed. Windows may display SmartScreen warnings. GitHub build provenance is a separate verification mechanism and does not remove those warnings.

[How to verify the installer](https://github.com/corelli18512/kraki/blob/win-v0.1.8/docs/BUILD_PROVENANCE.md).
