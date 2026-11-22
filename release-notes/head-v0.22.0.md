## Head 0.22.0

**Self-hosted relays: check before you update**
- **`VOICE_BROKER_URL`**: a cleartext `ws://` voice broker on a non-loopback host (a LAN address or a Docker service name) is now refused, and the relay does not start. Use `wss://`, or a loopback `ws://` address.
- **`KRAKI_HOST`**: the listen address is read from `KRAKI_HOST` (or `--host`); the old `HOST` variable is ignored since 0.21.0. If you still set `HOST`, rename it to `KRAKI_HOST`.

**Changes**
- **Slow clients**: above 32 MiB of unsent data the relay holds frames back (Pulse resends them later) instead of cutting the client into a reconnect loop; a client is disconnected only after 60 s without progress.
- **Relay restarts**: computers no longer go deaf to app commands after a relay restart (`@kraki/pulse` 0.5.3), and a multicast frame naming too many targets is consumed instead of stalling the sender's stream.
- **Devices**: an edge removes a device at the account service first (if that is unreachable, nothing changes and the app is told); an edge sign-in marks only the signing-in device as seen, so offline computers and abandoned browsers no longer look active.
- **Push**: an APNs notification lost to a dropped connection, a timeout or an expired provider token is retried; concurrent expiries mint one new token.
- **Self-hosting**: the provider's reason for refusing a pairing is passed on, a missing `GITHUB_CLIENT_ID` is reported as a relay problem, a proxy that does not upgrade to WebSocket gets its own explanation, and `OPEN_SHARED_KEY` is trimmed like the computers trim it.
- **Hardening**: a subscription to an unsafe session id is answered with `session_not_found`, and the unknown message type the relay echoes is capped at 64 characters.
- No other configuration change and no database migration; 0.21.0 still runs on the same database.
- Shared packages: `@kraki/protocol` 0.31.0 (adds `question_withdrawn`, the optional `clientId` and `code` on session errors, and `multiSelect` on questions), `@kraki/crypto` 0.2.5 (replay protection that does not depend on the receiver's clock; saves a new `v: 3` state), `@kraki/pulse` 0.5.3.
