# Account usage

Kraki shows how much Claude and Codex subscription quota is left, per account,
across every device. Quota belongs to the provider account, not the machine, so an
account signed in on several devices is shown once.

## Where it shows

- **iOS / iPadOS:** Devices tab → **Accounts** (top). A device's detail page lists
  the accounts signed in on that device.
- **macOS:** menu bar → **Account Usage**, or hold a shortcut (off by default; turn it on
  in Settings → General → Account Usage, default F6). Hold to see an overview, move
  the pointer in for detail, release to dismiss. The account the open session is
  spending is listed first and highlighted.

Each account shows one ring per quota window the provider reports (5-hour and/or
weekly), its reset time, plan and the devices it is signed in on. Older readings
(a failed refresh, an expired login) stay visible, greyed and marked **Stale**.
Devices running an older Kraki are named with a hint to update them.

### Refresh and freshness

The Mac detail panel (hover into the F6 overview, or open it from the menu) and
iOS account sections have a **Refresh** button. Details show the last successful
reading's age and a reason for failures: sign-in needed, rate limited (with a retry
deadline), or couldn't refresh. Offline devices are called out separately. On Mac,
hover the update time to see its absolute timestamp. A failed attempt does not
change that time or erase the last known quota.

Opening the Mac panel or iOS Devices page also requests a reading when the cached
data is at least one minute old or has an error. Fresh data is reused. Repeated
opens/clicks are coalesced, with a one-minute client cooldown; provider cooldowns
remain authoritative. Replicated accounts are covered by a small set of online
refresh-capable devices rather than querying every replica. A device-detail
button intentionally targets that device. A refresh can return cached data when
a provider is backing off: it does **not** promise a new provider reading.

Normal background collection remains **15 minutes ±10%**, with a read at startup.
A successful reading becomes stale after two worst-case polling intervals plus
one minute of grace (**34 minutes** by default). The worker reports a threshold
matching its configured interval; older workers without this field use the
15-minute default. Any reported read error still marks data stale immediately.
The old fixed 11-minute threshold incorrectly marked normal polling gaps stale.
`Stale` does not mean the quota is exhausted. Ring `↻` times are **quota window
resets**, not refresh times or rate-limit retry deadlines.

Refresh is enabled only for online devices advertising the new capability.
Older/disabled workers show a hint instead of an indefinite spinner. Requests are
connection-scoped (not replayed on reconnect); disconnects and a two-minute UI
timeout end pending requests. Provider exception bodies and credentials are never
sent to the UI.

## How it is read (tentacle)

Every tentacle reads the logins already on its machine, read-only:

| Source | File |
|---|---|
| Pi | `$PI_CODING_AGENT_DIR/auth.json` or `~/.pi/agent/auth.json` (`anthropic`, `openai-codex` OAuth entries; API keys ignored) |
| Codex CLI / app | `$CODEX_HOME/auth.json` or `~/.codex/auth.json`; without a usable token, Codex's own `codex app-server` answers |
| Claude Code | `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json` (Linux / Windows; macOS keeps it in the Keychain, which is not read) |

It then calls the providers' subscription usage endpoints
(`api.anthropic.com/api/oauth/usage`, `chatgpt.com/backend-api/wham/usage`) every
15 minutes (±10 %), honoring `HTTP(S)_PROXY`, `NO_PROXY` and `Retry-After`. The
collector does not copy or log tokens; bearer tokens go only to the owning
provider's HTTPS endpoints. Kraki apps receive only percentages, reset times,
plan ids, a masked email, reading status/timing and which agents use each account.

When a **Pi** login has expired the tentacle runs `pi auth check --provider … --json`,
which renews it under Pi's own lock on `auth.json` (at most every 10 minutes per
login). Codex renews its own login inside `codex app-server`.

Readings are appended to `KRAKI_HOME/usage-history.jsonl` (0600) for a future
history view; no credentials or emails are stored there.

## Configuration

`~/.kraki/config.json`:

```json
{
  "accountUsage": {
    "enabled": true,
    "intervalMinutes": 15,
    "renewPiLogins": true
  }
}
```

- `enabled: false` (or `KRAKI_ACCOUNT_USAGE=0`) turns it off entirely.
- `intervalMinutes` is clamped to 10–120.
- `renewPiLogins: false` never runs `pi auth check`; an expired Pi login then shows its
  last reading as stale until Pi is next used.

## Protocol

- `device_usage` (tentacle → app): sent to each app on join and broadcast on change.
  Accounts optionally include `staleAfterSeconds` and `retryAt` (provider backoff).
- `refresh_account_usage` (app → one tentacle): `{ requestId }`. A targeted
  `device_usage` reply echoes `requestId`, even if nothing changed or a cooldown
  prevented fetching. Optional `refreshError` reports disabled/busy/unavailable;
  per-account provider errors remain in `accounts[].error`.
- Only known app keys may request refresh. The worker shares an in-flight read
  across apps and bounds pending replies to one per app. The monitor shares reads
  with its timer, enforces a 60-second per-source minimum, and honors 429
  `Retry-After` even when the same account's token rotates.
- `request_usage_history` / `usage_history`: local readings for a history view.
- The greeting advertises `account_usage` when enabled, and
  `account_usage_refresh` when its refresh handler is installed. New fields are
  optional; older apps ignore them. Head only forwards encrypted envelopes and
  requires no deployment for this feature.

## Known limits

- The usage endpoints are the ones the official clients use, not published APIs; an
  unrecognized response shows "Unavailable" rather than an estimate.
- Claude Code logins kept only in the macOS Keychain are not read.
- Each tentacle still polls its own accounts in the background. Jitter reduces
  synchronized calls, but shared accounts can still hit provider rate limits.
  Manual refresh cannot bypass them.
- Old workers with a custom polling interval cannot communicate their freshness
  threshold; upgrade those workers to get cadence-aware status and manual refresh.
