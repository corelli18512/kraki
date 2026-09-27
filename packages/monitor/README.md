# @kraki/monitor

Independent client diagnostic-log REST collector. **Not the Head relay**, not a
chat log sink, and not a dashboard. It only accepts signed, schema-allowlisted
metadata from registered app devices. Node **24+**; no runtime npm dependencies.

```text
Client ── WebSocket/Pulse ── reverse proxy ── Head (normal chat)
       └─ HTTPS /api/diag/v1/* ────────────── Monitor (diagnostic metadata)
                                               ├─ private gzip batch directory
                                               └─ readonly registered-device keys
                                                  from existing Head SQLite DB
```

## Ownership / boundaries

- `src/cli.ts`: dedicated HTTP process, bound to `127.0.0.1:4011` by default.
- `src/diag-api.ts`: signed-device auth, event allowlist, quotas, retention and
  idempotent storage. No arbitrary text/body/error logs or public download API.
- `src/device-keys.ts`: minimal `DiagnosticDevice` contract and read-only SQLite
  adapter. Reads only `devices(id, user_id, role, public_key)` on demand; observes
  WAL updates, role changes, key rotation and revocation without caching keys.
  Does not read sessions/messages, write/migrate the DB or create a missing DB.
- `scripts/deploy.sh`: collector-only deployment; never upgrades/restarts Head.
- No dependency/import on `@kraki/head`, its Storage implementation, Pulse,
  Tentacle, protocol or crypto packages. The existing **database column contract**
  is the only Head-specific integration and must be maintained when schemas change.
- Client instrumentation, offline timeline tools and native E2E remain in the
  client and `scripts/diag`; those tools test/consume the collector, not vice versa.

## Build / run

From repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:monitor
KRAKI_DIAG_DB=/absolute/path/to/existing-head.db \
KRAKI_DIAG_DIR=/absolute/path/to/private-diagnostic-logs \
  pnpm start:monitor
```

Both paths are required. Do not point test runs at production data. `dev:monitor`
provides the same explicit-env startup via tsx watch; it does not start Head or
silently load Head's `.env`. The service account must be able to read the existing
SQLite database and its WAL/SHM; use the established readonly-WAL deployment setup.

| Environment | Meaning |
|---|---|
| `KRAKI_DIAG_DB` | Existing registered-device SQLite DB, opened read-only |
| `KRAKI_DIAG_DIR` | Dedicated private log directory; one collector per directory |
| `KRAKI_DIAG_PORT` | Optional loopback port, default4011 |
| `KRAKI_DIAG_REVISION` | Optional build revision returned by `/health` |

- `GET /health`: loopback service identity/revision, not device credentials.
- `GET /api/diag/v1/config`: authenticated collection configuration.
- `POST /api/diag/v1/batch`: authenticated gzip JSON metadata batch.
- RSA request signatures, `/api/diag/v1/*`, batch IDs and opaque storage paths are
  unchanged by the extraction. No service Bearer is sent to a client.
- `touch "$KRAKI_DIAG_DIR/DISABLED"` stops collection without touching Head.
- TLS/public routing must be provided by the reverse proxy. Metadata is not E2E
  encrypted or anonymous; keep logs and downloaded evidence private.

The full protocol and privacy/size/quota constraints are in
[`docs/client-diagnostics-design.md`](../../docs/client-diagnostics-design.md).

## Tests

```sh
pnpm --filter @kraki/monitor typecheck
pnpm test:monitor
pnpm exec tsx scripts/diag/local-e2e.ts  # macOS: actual Swift RSA + URLSession
```

`test:monitor` builds the package, then runs API/privacy/quota/idempotency tests,
read-only DB failure tests, and real child-process integration for current WAL
keys, role enforcement, key rotation/revocation, service restart and exact batch
retry. Integration runs against both source and the deployable build using only
three emitted JS files + a module manifest in an
isolated temporary directory outside the workspace (no node_modules or Head code).
Root `pnpm test` / `pnpm validate` include this suite, so existing CI runs it.

The receiver also accepts the reliability fix's new `ws.state.source/count` and
`outbox.state.phase=unconfirmed` metadata; unknown fields/phases still fail closed.

## Deployment / migration

This refactor changes source ownership, not existing service/data identity:

- Keep systemd service **`kraki-diag`**, `/opt/kraki-diag/releases/...`,
  `/var/lib/kraki-diag`, port4011, public routes and environment variable names.
- Deploy from a committed revision and rebuild that revision first (the release
  directory/revision uses git HEAD). Build **Monitor**, not Head. The deployed payload is `dist/cli.js`,
  `dist/diag-api.js`, `dist/device-keys.js` plus `{"type":"module"}`.
- Canonical entry (only with explicit operator authorization):

  ```sh
  bash packages/monitor/scripts/deploy.sh \
    <ssh-host> <absolute-node24> <absolute-head-db> <service-user> \
    <nginx-or-caddy> <absolute-proxy-config>
  ```

- `scripts/diag/deploy-sidecar.sh` remains a compatibility forwarding wrapper.
- Only the collector is restarted. The deploy script backs up the previous unit
  and proxy config, validates/reloads the proxy and checks Head PID is unchanged.
  Existing logs are not relocated, repacked or deleted by deployment.
- The new Head no longer embeds the collector or honors `KRAKI_DIAG_DIR` for
  collection. Misrouted `/api/diag/v1/*` requests to Head return404, not the generic
  health200. Anyone using the old optional **embedded** mode must first deploy
  Monitor and route these paths to it before upgrading Head. Existing independent
  collector deployments do not need a Head upgrade/restart for this migration.
- Deploy the updated collector allowlist before distributing the new diagnostic
  client. Otherwise new metadata fields would cause whole batches to be rejected.
- For rollback, restore the previous backed-up service unit (which references the
  old `diag-sidecar.js` release) and proxy configuration as needed, then restart
  **only `kraki-diag`**. Keep its data directory; no Head DB migration is involved.

No deployment is performed by building or testing this package.
