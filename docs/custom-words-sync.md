# Custom Words account sync

Custom Words belongs to the **Kraki account**, not a session, computer, Tentacle,
or Apple ID. iOS and macOS share the implementation. Web currently has no voice
input/Custom Words editor; this change does not add one. Correct Transcripts and
Use Conversation Context remain device-local.

## Privacy and storage

Words and mishearings are ordinary readable account data, transported over TLS/WSS
in hosted deployments (self-hosters must configure TLS). They are not E2E encrypted.
The regional head stores `users.preferences.voiceVocabulary`; DB backups include
this data. No Tentacle is required. Chat encryption is unchanged. This does not
replicate data between independent relays/regions.

The native client keeps an account/relay-scoped snapshot and durable pending edits
in UserDefaults. `voice.vocabulary` remains a derived cache for the next dictation
request. Logout clears that active cache and retires the transport; it retains
account-scoped offline edits so signing back into that account can resume them.

## Protocol

- `auth_ok.voiceVocabulary`: `{version: 1, revision, entries}`. Its presence is also
  the capability gate. Clients never upload words to an older server.
- `update_voice_vocabulary`: `{requestId, changes}`; each change has `changeId`,
  stable UUID `id`, `baseRevision`, `action` (`upsert`, `delete`, `import`) and, for
  non-deletes, `term` / `heardAs`.
- `voice_vocabulary_updated`: sender receives `requestId`, full `vocabulary` and
  per-change `results`. Other online apps on the account receive only the snapshot.
  Both responses use the existing head-to-device Pulse control transport. The
  native sender uses raw authenticated control JSON and its own durable outbox.
- Generic `update_preferences` ignores the reserved `voiceVocabulary` field so a
  stale preference client cannot replace the canonical state.

Each entry records its server-assigned revision and last applied change ID. The
head validates the whole batch before applying it transactionally. Repeating an
already-applied change is idempotent. Different words merge independently; a stale
edit of the same word returns a conflict rather than overwriting newer work.
Deletions retain ID/revision tombstones, with spelling/mishearings removed. Only an
explicitly rebased edit can restore a deleted ID.

The client persists edits before sending and clears only acknowledged change IDs.
Typing during an in-flight request is retained; its baseline advances only over
its own acknowledged write. Old responses cannot roll back newer snapshots.
Uploads debounce for 700 ms and unacknowledged batches retry every five seconds
while connected; reconnect resynchronizes and retries pending changes.

Conflict, duplicate, validation or capacity failures keep the local edit and show
a notice. **Retry My Changes** explicitly rebases blocked edits on the current
snapshot; **Use Synced Words** discards blocked edits, not unrelated pending work.
Nothing auto-rebases a stale edit over a deletion.

## Migration and bounds

On the first account activation per installation, legacy local words are backed
up and queued once as imports. Their deterministic IDs are the first 128 bits of
SHA-256 of `kraki.voice.legacy:` plus NFC-normalized, lowercased spelling, formatted
as UUIDs. This identifies the same legacy word across devices, including after
its deletion or rename. The backup is not automatically imported into another
account after logout.

Imports union mishearings for the same spelling, leave existing canonical spelling
unchanged, and never undo a tombstone/rename. Normal words get random stable UUIDs.
The existing limit is 100 active words and 120 graphemes per formatted entry. The
server additionally bounds raw input size, batches (100) and retained records
(2,000, including tombstones). Overflow is explicit and local words remain saved;
there is no silent truncation or tombstone eviction. A future retention protocol
would be needed to safely compact very long-lived deletion history.

## Release order and tests

Deploy head first, then native clients. Old clients keep using local words; new
clients connected to old heads retain edits locally and show that sync is waiting.
No database schema migration or encryption migration is required.

Tests cover native migration/restarts, account and relay isolation, live cache
refresh, in-flight editing, out-of-order acknowledgements, deletion conflicts,
invalid editing drafts, migration overflow and deduplication. Head tests cover
normalization/validation, idempotency, concurrency, tombstones, import merging,
capacity, reserved preference protection, same-account live delivery, reconnect
hydration, and cross-account isolation without a Tentacle.
