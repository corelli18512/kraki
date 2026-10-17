# Kraki for Windows 0.1.5

Windows 10/11 x64 preview, including Kraki CLI 0.38.10. This release brings the Windows app closer to Kraki for Mac in behavior while looking at home on Windows.

**Looks native**
- New app and tray icon: the full-colour octopus without a background tile, filling the frame so it is no longer small on the taskbar. The tray icon dims while this PC goes online/offline or is offline, and shows a dot when a session needs you.
- The taskbar button shows how many messages are unread (1–9, 9+).
- Settings closes with a Windows-style × instead of a Mac-style red dot.

**Fixes**
- Turning notifications off in Settings now really stops desktop notifications.
- Stop no longer spins forever when it can't be sent, and an unconfirmed Stop is never replayed after reconnecting, where it could stop the next turn.
- Rename… on the current session in the sidebar opens Session Info; the title editor spans the row with the title selected.
- A question no longer hides an approval that was already waiting; an answer that could not be sent keeps its question open.
- A denial reason that could not be sent comes back in the composer.
- Enter sends on touchscreen laptops with a keyboard.
- Messages covered by an expanded composer can be scrolled into view.
- Image preview takes keyboard focus; a failed subagent report shows the error instead of loading forever.
- A message sent while the agent is still working no longer shows as unconfirmed; a message sent while reconnecting is delivered automatically when the connection is back.
- Settings: Account shows “Signed in via” like Mac, Device ID moved to About; Custom Words are added inline.

This preview installer is still not Authenticode-signed. Windows may display SmartScreen warnings. GitHub build provenance is a separate verification mechanism and does not remove those warnings.

[How to verify the installer](https://github.com/corelli18512/kraki/blob/win-v0.1.5/docs/BUILD_PROVENANCE.md).
