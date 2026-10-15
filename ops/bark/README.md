# Private Bark transport

Third-party `Finb/bark-server` **v2.3.9** runs as its own unprivileged systemd
service on each relay host. Its source is not forked or copied into Kraki. This
directory contains deployment glue only; `../watch/lib/bark.mjs` is our client.

## Boundaries

- One native binary per host, pinned to GitHub release asset SHA-256 (see
  `install.sh`). Tokyo uses Linux armv8; China uses Linux amd64.
- `127.0.0.1:4080/bark`, persistent private state `/var/lib/kraki-bark` (0700),
  service `kraki-bark`, user `kraki-bark`. Limits: 128 MB / 20% CPU / 64 tasks.
- Public phone registration at `https://relay.kraki.chat/bark` and
  `https://cn.relay.kraki.chat/bark`. Existing TLS/DNS are reused.
- **Only `/bark/ping` and `/bark/register` are public.** Public `/push`, generic
  `/<key>/<message>`, `/info`, MCP and other endpoints return 404. This is a
  private monitoring transport, not a general public Bark push service.
  Consequently the App's sample public push URLs are intentionally unusable;
  use the monitor's explicitly authorized local notification test instead.
- Watch sends to its own loopback Bark, so it does not depend on its local
  reverse proxy. Each host also probes the other host's public Bark ping.
- Bark upstream logs full URL/body, including tokens. Both process output
  streams are discarded. Proxy access logs for these endpoints are disabled.
  systemd still reports service lifecycle and exit status.
- Public registration must remain accessible for phone token refresh. It can
  create device records but cannot send a push through our public endpoint.
  Request bodies are capped at 16 KB; registration abuse/storage growth is an
  operational risk to revisit if the endpoint receives unexpected traffic.
- Self-hosting removes `api.day.app` from the path, **not** the dependence on
  the official Bark iOS app, its Apple push identity/credentials, or APNs.

## Authorized installation

No commands here should be run on production without approval. No relay restart
or client release is involved. First record the relay's PID/start time and health.

1. Download the matching binary from
   `https://github.com/Finb/bark-server/releases/tag/v2.3.9`, copy it and this
   directory to the host. `install.sh` verifies it before installing:
   ```sh
   sudo sh ops/bark/install.sh /staged/bark-server_linux_armv8  # Tokyo
   # China: bark-server_linux_amd64
   ```
   It starts/restarts **only Bark**. Run `systemctl status kraki-bark` and check
   `http://127.0.0.1:4080/bark/ping`. Version is available from loopback `/bark/info`.
2. Back up the proxy configuration privately, then render a candidate:
   ```sh
   python3 ops/bark/proxy-config.py caddy EXISTING_CONFIG > CANDIDATE
   # or nginx on the China host
   ```
   The renderer refuses unexpected layouts or a second patch. Check that the
   source has not changed since backup; validate with `caddy validate` / `nginx -t`,
   install atomically, then **reload**, never restart, the proxy. If validation
   or reload fails, restore the backup. Leave existing relay/collector routes
   unchanged. For nginx, testing the candidate may require temporarily replacing
   the on-disk site file; the running config is unchanged until reload.
3. Verify TLS public ping from the Mac and the other host, empty registration
   returns 400, and `/bark/push` and `/bark/info` return 404. Confirm existing
   HTTP/WS/collector/voice endpoints and relay PID/start time are unchanged.
4. Stage `/etc/kraki/watch.env` (0600) **before** starting the watch timer:
   ```sh
   BARK_SERVER=http://127.0.0.1:4080/bark
   BARK_KEY=
   KRAKI_WATCH_NOTIFY=0
   HC_PING_URL=
   ```
   Include the remaining values from `../watch/watch.env.example`. Install with
   `sh ops/watch/install.sh tokyo` (or `cn`) and run `kraki-watch check-config`.
   Do not use `--with-backup` or `--with-journal-policy` unless those separate
   operational changes are approved. Inspect shadow output before enabling.
5. Add both HTTPS server addresses in the official phone App. Each returns its
   own key. Set the respective host's `BARK_KEY` privately. Never post the keys
   to GitHub or log them. With the operator present, explicitly enable sending,
   test critical/warning delivery and recovery, and confirm actual phone receipt.

Missing backup jobs and external heartbeat/email setup are **not** completed by
this installer. Backup checks intentionally expose missing scheduled backups in
shadow mode; resolve the gap before treating the system as fully commissioned.
No Apple request/response can prove phone display or critical-alert sound.

## Validation and rollback

Local tests (also run by the existing watch CI job):
`node --test ops/watch/test/*.test.mjs`. Includes proxy-render safeguards,
paired local/peer checks, Bark response/redirect handling and a real CLI/fake
service stack. Unit file and real proxy validation must also run on Linux.

Installation keeps versioned binaries and prior service metadata under
`/var/backups/kraki-bark/`. For rollback, restore the prior proxy file and validate
before reload; disable the **watch timer and Bark service only**, or restore the
previous Bark binary symlink/unit and restart Bark. Retain `/var/lib/kraki-bark`
so phone registration survives; never delete/reinitialize it as part of rollback.
Do not touch relay databases, services or the user's local Kraki app.
