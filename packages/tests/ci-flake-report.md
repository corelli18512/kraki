# CI flake investigation — 2026-10-22

Branch: `lane2/flaky`; starting revision: `23b3e5d6`.

**Four test/fixture races fixed; no production behavior or thresholds changed.**
Four composer cases were already addressed by main's `2cac0855`. Five other
native cases remain unresolved, not declared fixed merely because they passed.
The supervisor approved leaving unreproduced cases untouched after repeated
normal/CPU-load runs rather than making speculative fixes or relaxing assertions.

## Per-item disposition

Every native case below passed **10 consecutive baseline iterations and 10
consecutive final CPU-load iterations**. The two added native regressions also
passed 10 consecutive final CPU-load iterations. Neither native run used retries.

| Case | Status / evidence |
| --- | --- |
| `IOSComposerGrowthShots.testRecordingTextStaysTopAlignedAcrossWrappingAndResize` | Already addressed by `2cac0855`; opt-out from the fixture's delayed canned partial prevents it overwriting explicitly driven text. CI job `119368311681` sampled a 13.305pt top gap instead of 12pt; other jobs sampled replacement-text geometry. Assertions unchanged. |
| `ComposerGeometryProbeTests.testRecordingAndMultilineComposerLeaveTailInPlace` | Already fixed by `2cac0855`: delayed canned partial replaced the long transcript, leaving 51/59pt rather than >100pt scroll reach (jobs `115201727002`, `119368311681`). Assertions unchanged. |
| `IOSComposerGrowthShots.testStartingVoiceKeepsDraftWidthAndDoesNotShrinkExpandedDraft` | Already fixed by `2cac0855`: job `119015494438` saw draft + canned Chinese partial after explicitly clearing speech. Assertions unchanged. |
| `IOSComposerGrowthShots.testVoiceStatesAndFades` | Already addressed by the same canned-partial opt-out; job `119288108006` saw only 58.333pt of content instead of long dictation. No additional speculative geometry changes. |
| `IOSSearchIMETests.testPinyinCompositionDoesNotFilterOrInterruptTheField` | Fixed missing readiness wait. Job `119368311681` found the field not yet focused after the fixed appearance drain. `openSearch` now waits for the actual native first responder, without requesting focus itself. New `testOpenSearchWaitsForDeferredNativeFocus` queues a native focus handoff: fails before, passes after. |
| `NewSessionJourneyTests.testNewSessionJourney` | Fixed scripted-producer timer catch-up. Job `118956992684` first sampled 3.6s after send; the next sample already had the final reply and missed the live card entirely. Absolute timers queued the whole stream during the stall. The DEBUG-only producer now yields between relatively paced chunks. New `testScriptedReplyRemainsStreamedAfterMainThreadStall` deliberately blocks the main queue for 4s: fails before, passes after. Existing seven journey checks preserved. Class moved from `ChatUXRegressionTests.swift` to `NewSessionJourneyTests.swift` to keep source discovery clear and avoid growing its SwiftLint file-length violation. |
| `VoiceDraftNativeTests.testEditProgressAndSelectionTakeoverInLightAndDark` | **Unresolved.** Job `117965019644` exceeded recording/ASR readiness, followed by cascading edit/selection failures. Its existing condition waits were retained; the original failure was not reproduced. |
| `AccountUsageTests.testDevicesPageRefreshesWhenConnectionAndGreetingArriveAfterAppearance` | **Unresolved.** Job `115662776559` exceeded the existing 5s refresh expectation. Existing task-ID observation/condition expectation retained; no reproducible missed refresh locally. |
| `IOSImagePreviewSwipeTests.testOpensOnTheTappedImageCentred` | **Unresolved.** Job `119307167040` captured blue after a synthetic swipe back should have shown green. No reproduction; no unproven gallery/product change. |
| `IOSMotionTests.testStreamingGrowthMovesTheConversationSmoothly` | **Unresolved hardware/timing failure.** Job `118867199885` measured 16.8257pt against 16pt (brief also reports 17.17pt). Local distribution below does not justify changing the limit. |
| `KrakiVoiceInputTests.testCorrectionAlignmentOnLongDictationFindsTheConsumedPrefix` | **Unresolved hardware/timing failure.** Brief reports 0.558s against 0.5s; local distribution does not approach that boundary. Algorithm, correctness assertion, and timing limit retained. |
| TypeScript `rate limits a device including replayed requests` | Fixed wall-clock bucket assumption. The diagnostic collector moved from Head to `packages/monitor`; current Head's other rate-limit test was not the failing case. Inject the existing collector clock into the fixture and matching signed timestamps. Test 30 accepted replays, 31st rejected, advance across the calendar-minute boundary, and test the entire budget again. Deliberately advancing across the boundary halfway through the old loop reproduced exactly `expected 204 to be 429`; the fixed case passed 10 consecutive runs under CPU load. No limiter semantics changed. |
| Web `e2e/replay.spec.ts`: `displays messages during replay and clears loading state` | Fixed listeners installed too late. `page.goto` can finish after the WS connection/auth messages. Authentication listeners now start before navigation; response listeners are installed before sending `auth_ok`. A document image held until authentication deterministically makes connection precede navigation completion: before fix, 30s navigation timeout; after fix, 10/10 passes, then another 10/10 in the full-file repeat. No sleeps/retries added. |

## Performance measurements (not new baselines)

Host: macOS arm64, 18 logical CPUs; dedicated iPhone 17 Pro iOS 26.5 simulator.
CPU stress: 12 owned `yes >/dev/null` processes for the whole final native run,
terminated afterward. This host is not a substitute for measuring a slow CI runner.

| Metric, 10 samples per run | Normal min / median / max | Final CPU-load min / median / max |
| --- | --- | --- |
| Streaming worst on-time frame step (pt, existing `IOSMOTION` instrumentation) | 12.1 / 12.4 / 13.0 | 12.1 / 12.4 / 12.8 |
| Long alignment XCTest wall duration (s, includes assertions) | 0.040 / 0.041 / 0.046 | 0.051 / 0.0545 / 0.056 |

An earlier interrupted stress attempt measured frame steps up to 14.5pt. None of
these data justify a threshold relaxation; no proposed replacement threshold.

## Verification and evidence

Retained evidence root: `/tmp/kraki-flaky-evidence`.
CI details were fetched with `gh api repos/corelli18512/kraki/actions/jobs/<id>/logs`;
files use the job ID as their basename. `assertions.txt` extracts native failures.

- Baseline: `native-before-repeat.log`, `before-repeat.xcresult`: **110/110**
  (11 named native cases × 10).
- Final CPU load: `native-stress-after.log`, `native-stress-after.xcresult`,
  `native-final-summary.json`: **130/130** (11 named cases + 2 regressions × 10),
  xcodebuild exit 0. Per-case counts and timing values are in the summary JSON.
- Native failure proofs: `ime-deferred-before.log` / `.xcresult` and
  `/tmp/kraki-native-test.3MrLfD/test.log` (scripted-stall regression). Both
  fail their intended assertion before the corresponding fix.
- Playwright failure proof: `replay-regression-before.out` (load-gated navigation
  times out before listeners are installed).
- `replay-after.out`: target **10/10**. `replay-all-after.out`: **40 passed**,
  **20 pre-existing skips** (four active cases × 10, retries disabled).
- Rate-limit failure proof: `rate-limit-before.out` (minute-crossing old loop).
  `rate-limit-after-{1..10}.out`: **10/10** fixed-case runs.
- `monitor-suite-built.out`: **24/24**. `head-suite.out`: **389/389**.
- `web-suite-no-load.out`: **1205/1205**, 125 files. Web and monitor typechecks pass.
- `swiftlint-after.out`: **280 violations, none beyond baseline (291)**.
- `git diff --check`: passes.

Commands used (dependencies already installed; no installs or lockfile changes):

```sh
# Native initial builds use the safe runner's isolated HOME/project/bundle ID.
KRAKI_RUN_UI_TESTS=1 KRAKI_TEST_SIMULATOR=E83E552D-348D-4636-A735-E708DE8EE816 \
  bash scripts/test-native.sh ios -only-testing:KrakiTests/NewSessionJourneyTests \
  -only-testing:KrakiTests/IOSSearchIMETests
# The same runner also built the baseline selections listed in the table.
# Repetitions reused its isolated project, not the production app/project HOME:
env -u KRAKI_HOME -u KRAKI_ALLOW_TEST_MICROPHONE \
  -u SIMCTL_CHILD_KRAKI_ALLOW_TEST_MICROPHONE HOME=/tmp/kraki-native-test.m7hxEL/home \
  xcodebuild -project /tmp/kraki-native-test.m7hxEL/project/Kraki.xcodeproj \
  -scheme Kraki -destination 'platform=iOS Simulator,id=E83E552D-348D-4636-A735-E708DE8EE816' \
  -derivedDataPath /tmp/kraki-native-test.m7hxEL/derived -parallel-testing-enabled NO \
  -resultBundlePath /tmp/kraki-flaky-evidence/native-stress-after.xcresult \
  -collect-test-diagnostics never -test-iterations 10 \
  -only-testing:KrakiTests/AccountUsageTests/testDevicesPageRefreshesWhenConnectionAndGreetingArriveAfterAppearance \
  -only-testing:KrakiTests/ComposerGeometryProbeTests/testRecordingAndMultilineComposerLeaveTailInPlace \
  -only-testing:KrakiTests/IOSComposerGrowthShots/testRecordingTextStaysTopAlignedAcrossWrappingAndResize \
  -only-testing:KrakiTests/IOSComposerGrowthShots/testStartingVoiceKeepsDraftWidthAndDoesNotShrinkExpandedDraft \
  -only-testing:KrakiTests/IOSComposerGrowthShots/testVoiceStatesAndFades \
  -only-testing:KrakiTests/IOSImagePreviewSwipeTests/testOpensOnTheTappedImageCentred \
  -only-testing:KrakiTests/IOSMotionTests/testStreamingGrowthMovesTheConversationSmoothly \
  -only-testing:KrakiTests/IOSSearchIMETests/testOpenSearchWaitsForDeferredNativeFocus \
  -only-testing:KrakiTests/IOSSearchIMETests/testPinyinCompositionDoesNotFilterOrInterruptTheField \
  -only-testing:KrakiTests/KrakiVoiceInputTests/testCorrectionAlignmentOnLongDictationFindsTheConsumedPrefix \
  -only-testing:KrakiTests/NewSessionJourneyTests \
  -only-testing:KrakiTests/VoiceDraftNativeTests/testEditProgressAndSelectionTakeoverInLightAndDark \
  KRAKI_RUN_UI_TESTS=1 CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_ENTITLEMENTS= test
(cd packages/arm/ios && xcodegen generate)
node scripts/ci/swiftlint-ratchet.mjs
(cd packages/monitor && npx tsc --noEmit -p . && npx tsc -p . && npx vitest run)
(cd packages/head && npx vitest run)
(cd packages/arm/web && npx tsc --noEmit -p . && NODE_ENV=test npx vitest run --maxWorkers=4)
(cd packages/arm/web && npx playwright test e2e/replay.spec.ts --repeat-each=10 --workers=4 --retries=0)
```

`KRAKI_RUN_UI_TESTS=1` was used for the UI-gated native tests. Dedicated simulators
were created for this lane; no personal simulator was used. An early overlapping
repro/diagnostic runner terminated one stress iteration (`signal term`), so that
attempt is explicitly **not** counted as a passing suite. The clean final run
above supersedes it. Two exploratory detached-host focus repros could not mount
the native field and were discarded; the committed queued-focus regression
reproduces the intended missing wait directly.

The first monitor full-suite invocation lacked built `dist/cli.js`; building the
package fixed that setup failure. Broad web suites under synthetic CPU load also
exposed pre-existing timeouts/races in `message-provider.regression.test.ts`,
`ws-client.transport-integration.test.ts`, and `ChatView.history-status.test.tsx`.
They were not changed; the normal complete suite passes. These remain additional
CI determinism risks, not concealed by retries or runner-limit changes.

## Rebase onto main `8cc0ea44` — 2026-10-27

Rebased from `23b3e5d6` across 211 main commits. Main had not touched
`IOSNewSessionScenario.swift`, `NewSessionJourneyTests`, the IME `openSearch`
helper or `e2e/replay.spec.ts`; all fixes still apply and still fail before /
pass after on current main:

- Scripted-stall and deferred-focus regressions, with main's scenario and
  `openSearch` restored: both fail their intended assertion.
- Replay test with main's listener ordering (load gate kept): 30s `page.goto` timeout.

Only `diag-api.test.ts` conflicted (main added multi-device fixtures and a
`deviceId` request parameter); the injected clock was merged into both.
Main also added `rate limits by the client address the proxy forwards`, with the
same wall-clock minute race (121 requests against a 120/minute IP bucket).
Advancing the injected clock across `:00` mid-loop reproduces
`expected 204 to be 429`; it now uses the fixture clock too.

After the rebase (dedicated iPhone 17 Pro iOS 26.5 simulator, deleted afterward):
`NewSessionJourneyTests` + `IOSSearchIMETests` ×10 **70/70** (including main's new
IME test that uses the waiting `openSearch`); iOS full suite **879 executed,
0 failures**; Mac full suite **575, 0 failures**; Playwright `replay.spec.ts` ×10
**40 passed, 20 skipped**; both monitor rate-limit tests ×10 **10/10**; monitor 32/32;
web 1276/1276; Head 566/566 on re-run. Head's first run failed once in
`cli-lifecycle.test.ts` `InflightRequests > drain waits for open responses`
(`expected +0 to be 1`: a fixed 20ms sleep before a size assertion). It is not
changed here and is another CI determinism risk.

## Workflow / next action

`.github/workflows/ci.yml` selects job groups through `scope`. `Validate` only
aggregates those selected results and checks success versus expected skips; it
is not another test runner. Kraki's test scheme is already non-parallelizable.
No workflow changes or new jobs were needed.

Independent review is required. For the five unresolved native cases, collect
slow-runner condition/presentation traces and exact function timings before
changing product code or proposing hardware-specific performance baselines.
