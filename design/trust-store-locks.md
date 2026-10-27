# Issue #508: trust-store writer serialization

Status: **the two reproduced races are fixed** inside the existing lock-file
protocol (`packages/tentacle/src/trust-store.ts`, `withTrustLock`). PID reuse
(below) is unchanged. The retained store still serves encryption
pins/revocations even though shipping clients now use account access rather
than pairing-only access (`packages/tentacle/src/account-access.ts:1-3`). A
local writer race therefore matters; it is not a relay-triggerable attack.

## Root causes (before the fix)

1. **Lock publication was not atomic.** `tryCreate` called
   `writeFileSync(path, token, { flag: 'wx' })`: exclusive creation precedes
   the token write. A waiter could read the empty file, and
   `holderIsDead('')` returned true. It unlinked the live writer's inode and
   acquired a different lock at the same path; both processes then ran their
   read-modify-write concurrently (a stale device snapshot can overwrite a
   revocation; policy CAS loses its serialization).
2. **Recovery cleanup was not ownership-safe.** A waiter read a dead
   `<name>.recover` token and then unlinked the pathname. Another recoverer
   could replace that dead file with a live recovery lock in between; the
   waiter deleted the successor's lock.
3. **PID reuse is indistinguishable from a live holder.** Liveness is
   `kill(pid, 0)`. An abandoned token whose PID was reused blocks writers
   until that unrelated process exits: writers time out after five seconds
   (fail closed, no corruption). **Not changed by this fix.**

## Fix

Same files, same token format (`<pid>.<uuid>`), same `<name>.recover`
take-over lock, no new dependency, synchronous API unchanged.

- **Atomic publication.** A lock (main, recovery, or removal lock) is written
  completely to a fresh private temporary file and hard-linked into place
  (`linkSync` fails with `EEXIST` if the lock exists). The lock path is never
  observable without its token. Hard links work on APFS/HFS+, ext4/btrfs/xfs
  and NTFS (`CreateHardLinkW`). A file system without hard links falls back
  to the previous exclusive create.
- **Unwritten locks are live until proven abandoned.** A lock whose content is
  not a complete token (an earlier version between create and write, or the
  fallback above) is treated as held. It is taken over only once its mtime is
  older than 10 s, which still recovers a process that crashed in that window.
- **Ownership-safe removal of a dead recovery lock.** Each dead lock file has a
  unique name: its token (a UUID never written again) or, for an unwritten
  file, its inode and nanosecond mtime. Removal of that file runs under
  `<path>.<key>`, created exclusively. Only one process can hold the right to
  remove that particular file; once removed it can never reappear at the path,
  so the check-then-unlink cannot remove a successor. If a remover itself dies,
  its `<path>.<key>` lock is removed the same way one level deeper (bounded to
  three levels; beyond that, writers time out rather than guess).
- The main-lock take-over keeps the legacy `<name>.recover` lock, so new and
  earlier-version recoverers still exclude each other.

## Compatibility

- On-disk trust data (`devices.json`, `policy.json`, …) is untouched.
- Earlier-version processes running concurrently see only complete tokens from
  new processes, so they can no longer steal a new process's lock through the
  empty-file window. New processes wait out an earlier version's empty lock
  instead of stealing it.
- Residual mixed-version risk: an earlier-version process still runs the old
  unconditional dead-recovery cleanup, so it can still remove a successor's
  recovery lock while both versions run. This ends once every tentacle on the
  computer is upgraded.
- A remover that dies after removing a dead lock but before releasing its
  `<path>.<key>` file leaves that small file behind; it never blocks anything
  (its name refers to a lock that no longer exists). A crash between writing
  and removing a temporary file can likewise leave a `.*.lock.tmp` file.

## Tests

`packages/tentacle/src/__tests__/trust-store-lock.test.ts`:

- an initializing (empty) live `policy.lock` / `devices.lock` is not stolen;
- a successor recovery lock that replaced a dead one between read and unlink is
  not removed (deterministic fs schedule);
- an unwritten lock abandoned long ago is taken over;
- a dead recovery lock and a dead remover of it are both cleared;
- a published lock always holds its token, and no temporary files remain;
- locking still works when hard links are unavailable;
- four real processes doing concurrent policy compare-and-sets: the final
  revision equals the number of successful sets (no lost update).

`src/__tests__/device-trust.test.ts` (DT503-07) keeps covering ordinary
dead-holder take-over and never robbing a live holder.

## Not done

- PID-incarnation tracking (cause 3). A safe fix needs a process start time
  or a kernel-held lock; Node core exposes neither portably and synchronously.
- Kernel-held (`flock`/`LockFileEx`) locks or versioned immutable generations
  remain the long-term options if PID reuse or mixed-version cleanup becomes a
  practical problem. Either changes the protocol for every writer at once.
