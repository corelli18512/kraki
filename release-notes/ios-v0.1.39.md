# Kraki for iPhone 0.1.39

- Keep permission controls reachable at accessibility text sizes, including when text size changes while an approval is pending.
- Stack approval choices at accessibility sizes so their labels stay readable.
- Reconnect correctly when pairing with the same computer after signing out.
- Show pairing authentication errors and allow retrying with a fresh code without restarting the app.

The associated runtime source also fixes recovery of Claude sessions interrupted before SDK initialization; the isolated App Review sandbox uses that patched runtime.
