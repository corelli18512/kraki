## Internal (dogfood) accounts

- `internal` on an account is server-managed: `update_preferences` ignores it, so a client can no longer mark its own account internal (or clear it).
- New operator command `kraki-relay internal list | on <login> | off <login>` (main/standalone head; an edge refuses).
- Edge relays mirror `internal` from the account service at sign-in, and `auth_ok` merges local and backend preferences per key, with `internal` always taken from the account service.
- No protocol change. Web 0.17.2 uses the flag to put internal accounts on the dogfood bundle automatically.
