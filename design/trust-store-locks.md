# Issue #508: trust-store writer serialization

Status: **still valid; design only**. The lock implementation is unchanged.
The retained store still serves encryption pins/revocations even though shipping
clients now use account access rather than pairing-only access
(`packages/tentacle/src/account-access.ts:1-3`). A local writer race therefore
still matters; it is not a relay-triggerable attack.

## Reproduced root causes

The relevant implementation is `packages/tentacle/src/trust-store.ts:140-195`.

1. **Lock publication is not atomic.** `tryCreate` calls
   `writeFileSync(path, token, { flag: 'wx' })`: exclusive creation precedes the
   token write. A waiter can read the empty file, and `holderIsDead('')` returns
   true. It unlinks the live writer's inode and acquires a different lock at
   the same path. The original writer can finish writing through its open
   descriptor and enter its transaction with no corresponding pathname lock.
   Both processes can now execute read-modify-write concurrently. A stale
   device snapshot can overwrite a revocation; policy CAS can lose its
   serialization guarantee. Atomic rename of the JSON file alone cannot
   prevent lost updates.
2. **Recovery cleanup is not ownership-safe.** The cleanup at line 187 reads a
   dead recovery token and then unlinks the pathname. Another recoverer can
   replace that dead lock with a live recovery lock between those operations.
   The waiter deletes the successor's lock. Adding a second token comparison
   still leaves a check/unlink window, so it is not a complete fix.
3. **PID reuse is indistinguishable from a live holder.** `holderIsDead` checks
   only `kill(pid, 0)`, not process incarnation. An abandoned token whose PID
   has been reused remains blocked until the unrelated process exits; the
   current writer normally fails after five seconds rather than corrupting
   state. UUIDs distinguish lock ownership, but do not identify PID lifetime.

`packages/tentacle/src/__tests__/trust-store-lock.test.ts` deterministically
reproduces (1) for both devices and policy, and (2) by scheduling a replacement
between the recovery read and unlink. It uses only a temporary directory. The
three tests use Vitest `it.fails` because the defect is deliberately unfixed:
these are expected **assertion failures**, not passing safety guarantees. To
see the red results, temporarily replace `it.fails` with `it` and run:

```sh
cd packages/tentacle
npx vitest run src/__tests__/trust-store-lock.test.ts
```

All three fail on the current implementation. The existing live/dead-holder
test in `src/__tests__/device-trust.test.ts:823-838` covers ordinary takeover
but not these interleavings. The new tests are controlled schedules, not a
claim of exhaustive multiprocess/OS stress coverage.

## Options (not yet approved or implemented)

### A. OS-backed transaction lock (preferred if native integration is acceptable)

Use a kernel-held lock on a **stable file that is never unlinked**: an
appropriate `flock`/`fcntl` primitive on Unix, and `LockFileEx` on Windows.
Hold it across reread, expected-policy-revision check, mutation, and atomic
JSON replacement. Process/handle death releases it, removing token-publication,
recovery-cleanup and PID-reuse logic entirely.

Node core does not expose this portably. A reviewed native binding or helper
would need build/distribution support on every supported OS, plus a defined
handle/IPC lifetime on parent crash. The existing synchronous APIs must not
silently become asynchronous. Do not shell out to a presumed installed
`flock` binary or introduce platform-only locking in this lane. All writers
must use the same primitive; mixing old lock-file writers and new kernel-lock
writers is unsafe.

### B. Immutable generations with exclusive atomic publication

Read generation N, compute the complete next snapshot, write a private staging
file completely, then **exclusively publish** generation N+1 using a verified
same-filesystem atomic primitive (for example, an exclusive hard-link publish
where supported). Exactly one writer may win N+1; losers must reread and
recompute, including the policy expected-revision check. Readers must never
see partially populated generations. Plain `writeFileSync(..., 'wx')` has the
same empty-file window; compare-then-rename and mtime checks are not CAS.

This avoids a native dependency but changes the storage protocol. It needs
specified crash durability, generation ordering, bounded retries, safe
checkpoint/garbage collection without generation reuse, and migration of
**all** readers/writers, including old daemon/CLI versions. A simple
"version" JSON field with normal rename is insufficient. Keep devices and
policy changes serializable at least within each resource, and preserve
policy revision semantics.

## Required acceptance for a future implementation

- Convert the three expected failures to normal passing tests; retain the
  existing live/dead-lock and stale-store/revocation regression tests.
- Real subprocess tests: simultaneous enroll/revoke, concurrent policy CAS
  (one winner for one expected revision), owner SIGKILL during publication
  and during write, recovery contention, and PID-incarnation handling.
- Validate macOS/Linux/Windows filesystem and process-death behavior, private
  permissions, no stale revocation resurrection, and fail-closed write errors.
- Define mixed-version upgrade behavior before changing the locking/storage
  primitive. Do not relax signature, replay, pairing, or account-access policy.

No partial production patch is proposed here: atomic token publication alone
would leave the recovery/PID problems, and a safe cross-platform replacement
is larger than a contained issue-triage fix under the no-new-dependencies rule.
