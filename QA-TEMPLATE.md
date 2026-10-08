# Full manual QA pass

A by-hand run through every row of [FEATURES.md](FEATURES.md) on real
installs. It takes most of a day, so it is **not** run on every change: run it
before a big release (a new app, a new platform, a large rewrite) or when
asked. Day-to-day changes rely on the automated tests and on testing the rows
they touch.

## Rules

- **Never production.** Use a separate relay and test accounts/devices. Don't
  touch anyone's real Kraki install, data or sign-in.
- **Real installs.** Install the build the way a person would (DMG, installer,
  TestFlight), in clean virtual machines when possible.
- **Two kinds of finding.** *Bug*: something doesn't work. *Experience*: it
  works but is confusing, inconsistent between devices, or unlike the
  reference design (iPhone and Mac). Record both.
- **Evidence.** A screenshot or log line per finding.
- **Cross-device.** Many rows involve two devices (approve on one, see it on
  the other; sync of pins, words, names). Check the second device each time.

## Setup

1. A test relay: `node packages/head/dist/cli.js start --port <port> --auth github --db <tmp>/head.db`
   (`PAIRING_ENABLED=true`; for voice, `VOICE_LEASE_*` and a test voice
   gateway). Point the apps at it with `KRAKI_RELAY_URL` (CLI / Windows) or a
   pairing link (phone / browser).
2. Clean virtual machines for Mac and Windows; a phone or a mobile-sized
   browser for the phone side.
3. One coding agent configured in each machine (any model works).
4. Note the build versions under test.

## Recording

Copy this table into the report and fill one line per row and platform.
Status: **pass**, **bug**, **experience**, **not tested** (say why).

| ID | Platform | Status | Notes / evidence |
|---|---|---|---|
| A1 | Mac | | |
| A1 | Windows | | |
| … | | | |

## Report

- Date, builds, relay, machines.
- Counts per status.
- Bugs first, each with what happened, why (if found) and how to reproduce.
- Then experience findings.
- Rows not tested and why.
- Fixes made during the pass, with the tests that guard them.

Keep reports outside the repository (they hold screenshots). Rows that turned
out wrong or missing go back into FEATURES.md in the same change as the fix.
