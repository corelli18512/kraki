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

## How it is read (tentacle)

Every tentacle reads the logins already on its machine, read-only:

| Source | File |
|---|---|
| Pi | `$PI_CODING_AGENT_DIR/auth.json` or `~/.pi/agent/auth.json` (`anthropic`, `openai-codex` OAuth entries; API keys ignored) |
| Codex CLI / app | `$CODEX_HOME/auth.json` or `~/.codex/auth.json`; without a usable token, Codex's own `codex app-server` answers |
| Claude Code | `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json` (Linux / Windows; macOS keeps it in the Keychain, which is not read) |

It then calls the providers' subscription usage endpoints
(`api.anthropic.com/api/oauth/usage`, `chatgpt.com/backend-api/wham/usage`) every
15 minutes (±10 %), honoring `HTTP(S)_PROXY`, `NO_PROXY` and `Retry-After`. Tokens are
never written, copied, logged or sent anywhere; apps receive only percentages, reset
times, plan ids, a masked email and which agents use each account.

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
- `request_usage_history` / `usage_history`: local readings for a history view.
- The greeting advertises the `account_usage` feature when enabled. Older apps ignore
  these messages (they carry no `sessionId`).

## Known limits

- The usage endpoints are the ones the official clients use, not published APIs; an
  unrecognized response shows "Unavailable" rather than an estimate.
- Claude Code logins kept only in the macOS Keychain are not read.
- Each tentacle queries its own accounts; an account on three machines is queried by
  all three (15-minute interval with jitter keeps this well within limits).
