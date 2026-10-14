# Kraki for Mac 0.2.84

- Sign in and access your online computers without a mandatory device-pairing step.
- Keep existing encrypted connections, keys, message signatures and replay protection compatible with previous clients.
- Keep an explicit, confirmed recovery action if a saved connection can no longer be verified. Kraki never silently discards a saved verification key.
- Make the Help Improve Kraki notice a non-blocking card at the bottom-right of the window.
- Maintain Crypto and Pulse inside the Kraki repository, with shared cross-language tests and no encryption or transport wire-format change.

## Access-policy change

The previous “Only paired devices” access setting is retired. Updating a computer archives that setting and restores access for devices signed in to the same account. This mode trusts the server's account/device authorization; it does not protect against a malicious authorization server. Existing paired connections continue using signed v2 messages; unpaired devices keep the existing encrypted compatibility path.

Update the computer CLI to 0.38.9 first if it has the old pairing-only setting enabled. The Mac app includes CLI 0.38.9. No session history or identity keys are removed.
