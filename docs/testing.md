# Test scope and device safety

## Pick the smallest useful check

Do not run the full repository, simulator, desktop UI and performance suites after
every edit. Start with the changed component's focused regression test, then its
build/typecheck. Broaden coverage for shared contracts or before a cross-cutting
release. `pnpm validate` remains the explicit full TypeScript regression command;
it does not launch native apps or performance probes.

Examples:

```sh
pnpm --filter @kraki/tentacle exec vitest run src/__tests__/daemon.test.ts
pnpm --filter @kraki/arm-web test
node --test scripts/ci/test-scope.test.mjs
```

Never run live model, account, hardware or production-network tests as an implicit
follow-up to a unit test. Use a separate account/client and local services when an
end-to-end check is needed. Do not reset TCC, grant Debug microphone access, replace
the installed app, or kill unrelated daemons to make a routine test pass.

## CI routing

CI still reports the required **Validate** check on every PR and main push. It
aggregates the selected checks, including failure/cancellation; skipped unrelated
jobs do not block docs-only PRs. A missing diff/history conservatively runs all
routine groups. PR scope includes the entire PR, including deleted files, not
only the last commit.

| Change | Routine checks |
| --- | --- |
| Documentation | Routing tests and aggregate gate only |
| Web / Head / other TS packages | TypeScript lint, build and regression |
| CLI / crypto / installer / daemon smoke scripts | TypeScript + Linux/Windows/Mac binary lifecycle checks |
| Native app, native tests, native diagnostics | iOS functional regression + Mac build, diagnostics and fake-audio safety tests |
| Protocol, lockfile, root build config, CI routing | All routine groups |
| CI manual dispatch | All routine groups, **not** performance or real hardware |

The TypeScript group deliberately remains a shared regression suite because Head,
Tentacle and the Web receiver share protocol behaviour. It is not repeated in
Web deployment: beta/production deployment builds Web and its workspace
dependencies once, then runs Web tests. Release packaging retains binary-specific
tests, signatures/notarization, archive validation and artifact launch smoke tests.
Those check the deliverable, not a redundant full repository suite. TestFlight
continues to archive/validate/upload rather than rerun the full test set.

## Native local tests

Use the isolated runner rather than installing or launching the normal Dev app:

```sh
bash scripts/test-native.sh mac \
  -only-testing:KrakiMacTests/MacChatUXRegressionTests/testFailedInputOffersRetryAndDelete

# Select a dedicated, already-created iPhone Simulator; never a personal device.
KRAKI_TEST_SIMULATOR=<uuid> bash scripts/test-native.sh ios \
  -only-testing:KrakiTests/KrakiVoiceInputTests
```

Requires Xcode and XcodeGen. The runner generates a temporary project with separate
`chat.kraki.testscope.*` Bundle IDs, temporary HOME/data/build directories and
ad-hoc signing. Evidence is retained under `/tmp/kraki-native-test.*`. It does not
install over production/Dev, alter their permissions, or run a daemon. Optional
`KRAKI_SOURCE_PACKAGES_DIR` reuses a local Swift package checkout/cache.

The shared unit-test schemes set `KRAKI_TEST_ISOLATION=1`. Test hosts start with an
empty temporary app graph, not the user's Keychain/auth/network graph. UI fixtures
use a no-device audio policy and no-network voice session factory unless a test
explicitly injects fakes. The live audio policy also refuses permission requests,
input-device queries and audio activation under XCTest by default. Voice state
machine and ObjC audio-safety tests continue to use fakes and **remain routine**.
They must not be mistaken for microphone/hardware tests.

## Performance is manual, not a release gate

The following diagnostic/stress cases skip unless `KRAKI_RUN_PERF_TESTS=1`:

- all `MacChatUXProbeTests` (visual captures and performance probes);
- eight Mac long-stream, allocation-budget, fling and continuous-wheel cases;
- iOS production scroll gate and three long-stream/continuous-scroll/fling cases.

Functional regressions for delivery, retry, questions, voice draft state,
streaming geometry, layout and crash prevention remain enabled. Do not turn
performance probes into default CI steps, deploy checks or mandatory local gates.

```sh
# Explicit opt-in; this does not grant or enable a microphone.
bash scripts/test-native.sh mac --perf \
  -only-testing:KrakiMacTests/MacChatUXProbeTests/testProbeStreaming
KRAKI_TEST_SIMULATOR=<uuid> bash scripts/test-native.sh ios --perf \
  -only-testing:KrakiTests/IOSChatScrollProductionTests/testProductionScrollGate
```

Direct Xcode users can set the `KRAKI_RUN_PERF_TESTS=1` build setting (forwarded by
the shared schemes). Avoid parallel performance runs: timing depends on machine
load and results are diagnostic, not stable pass/fail criteria for unrelated work.

## Real microphone acceptance

Real recording is a separate, human-approved manual session using a dedicated
client/account and correctly signed app. The normal Debug/Release app's voice
behaviour is unchanged. A test-host launch additionally requires
`KRAKI_ALLOW_TEST_MICROPHONE=1` to use the live audio policy; no shared test scheme
or CI job sets it, and the hardware-free runner rejects it. It is **not** OS
permission and does not reset/grant TCC. Existing synthetic voice-hold UI tests
remain hardware-free; their injected fake policies do not need this switch.
