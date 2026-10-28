## Head 0.21.0

- **Device rename**: devices can be renamed from any app; the account service stores the name, edges mirror it, and every device is told (`device_renamed`, sent as presence). Older apps pick up the new name at their next sign-in.
- **Faster reconnects**: an edge answers challenge sign-ins for known devices locally (edge-local auth, with background status checks against the account service; `KRAKI_EDGE_LOCAL_AUTH=0` turns it off), an auth reply deadline, a short socket grace for backgrounded apps, and delta catch-up.
- **Security hardening**:
  - challenge nonces are issued and single-use (60 s), and a flood of challenge starts can no longer void another device's pending nonce;
  - Pulse payloads reassembled from fragments are credited to the Head-stamped sender, and an app's broadcast is forwarded to no other device;
  - Web Push subscriptions are accepted only on browser push services;
  - per-user caps on pairing tokens, preferences and device fields;
  - a keyless `open` relay listens on loopback only, refuses non-loopback hosts and proxied clients, and `OPEN_SHARED_KEY` is supported. The listen address comes from `KRAKI_HOST` / `--host` (not `HOST`).
- **Logging** (production log audit): per-request account-API logs with a request id shared between edge and account service, bounded auth-failure logs, ping-timeout disconnects with role and duration, health line on change or every 5 minutes.
- No new required configuration for existing GitHub-auth and edge deployments. The database migrates in place (adds `devices.display_name` and the edge auth cache); 0.20.5 still runs on the migrated database.
- Shared packages: `@kraki/protocol` 0.30.0, `@kraki/pulse` 0.5.2.
