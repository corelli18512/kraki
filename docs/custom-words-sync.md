# Custom Words account sync

Custom Words belongs to the **Kraki account**, not a session, computer, Tentacle
or Apple ID. iOS and macOS share the implementation. Web has no voice input and
is unchanged. Correct Transcripts and Use Conversation Context stay device-local.

The goal is sync the user does not notice: no status, no prompts, no conflict UI.

## Privacy and storage

Words and mishearings are ordinary readable account data, sent over TLS/WSS in
hosted deployments. They are not E2E encrypted. The regional Head stores them in
`users.preferences.voiceVocabulary = { version: 2, words: [{term, heardAs}] }`;
DB backups include them. No Tentacle is involved and chat encryption is
unchanged. Independent relays/regions do not replicate each other.

## Model

Head holds the account's list; it is the truth. Each device keeps a copy (the
next dictation request reads it, so voice input never waits on sync) plus an
outbox of edits Head has not acknowledged.

Devices never upload lists, only intents, one per changed word:

| Intent | Effect on Head |
|---|---|
| `add {term, heardAs}` | Append. If the word exists (case-insensitive), merge its mishearings. |
| `edit {from, term, heardAs}` | Replace `from`. If `from` is gone (removed elsewhere), add it back. If renamed onto another existing word, merge into it. |
| `remove {term}` | Delete if present. |

Head applies intents in arrival order; the later one wins. Because only intents
travel, a device that was offline cannot overwrite words it never touched, and
replaying an intent (after a lost reply) has no further effect. The one cost: if
two devices edit the same word at nearly the same moment, the earlier edit is
replaced without notice. Native code mirrors Head's apply function
(`VoiceWordList.apply`) for its local view; tests pin both to the same cases.

## Protocol

- `auth_ok.voiceVocabulary: [{term, heardAs}]`. Its presence is also the
  capability gate: a client never sends intents to an older Head and keeps them
  queued instead. Every auth_ok is a full resync.
- `update_voice_vocabulary {requestId, ops}`: up to 200 intents. Invalid intents
  are dropped individually.
- `voice_vocabulary_updated {words, requestId?}`: the resulting list, to the
  sender (acknowledges `requestId`) and, if anything was applied, to the user's
  other online apps. Head-to-device control over Pulse.
- `update_preferences` cannot write `voiceVocabulary`, and `auth_ok.user.preferences`
  / `preferences_updated` never include it, so a theme change doesn't carry the list.

## Client

Edits show immediately and are persisted with the outbox, per account. 0.7 s after
the last change the store diffs the rows against the last flush (so Mac
keystrokes collapse into one intent per word) and sends the outbox; the reply
removes the acknowledged intents. No reply in 5 s: resend. A received list is
rendered with the remaining outbox applied on top, keeping row identity, raw
text being typed and empty draft rows.

On the first sign-in per installation, the old device-local words are backed up
and sent as `add` intents, merging with words from the user's other devices. They
are not imported into a second account. Signed out, the list is hidden and not
editable; an account's queued edits stay stored for its next sign-in.

Limits: 100 words and 120 graphemes per entry; extra additions beyond 100 are
ignored by Head and the client then shows Head's list.

## Release order and tests

Deploy Head first, then native clients. Old clients keep using local words.
No DB schema migration.

- Head unit/integration: intent parsing and normalization, merge/replace/re-add
  rules, limit, reserved field, live fan-out, reconnect hydration, malformed
  requests acknowledged, account isolation, preferences not carrying the list.
- Native unit (iOS + Mac): diff to intents, optimistic view with acknowledgement,
  drafts and row identity across remote updates, migration, account isolation,
  apply parity with Head.
- End-to-end: `pnpm -r --filter @kraki/tests... build`, then
  `bash scripts/chaos/run-native.sh -only-testing:KrakiMacTests/VoiceVocabularyNetworkTests`.
  Two production-networking clients of one account against a local Head: live
  add/edit/delete; an offline edit surviving a relaunch and merging with the other
  client's edit; concurrent edits of one word converging on the later one; an
  offline edit of a word deleted elsewhere bringing it back.
