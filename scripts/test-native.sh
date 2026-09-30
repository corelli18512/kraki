#!/bin/bash
# Isolated local native regression. No production app, login, daemon or microphone.
# Usage: bash scripts/test-native.sh mac|ios [--perf] [xcodebuild test selectors...]
# Window/voice tests (they can take window focus) are skipped unless
# KRAKI_RUN_UI_TESTS=1; CI turns them on.
set -euo pipefail
platform="${1:-}"
case "$platform" in mac|ios) shift ;; *) echo 'Usage: test-native.sh mac|ios [--perf] [xcodebuild selectors...]' >&2; exit 2 ;; esac
perf=0
if [[ "${1:-}" == '--perf' ]]; then perf=1; shift; fi
# Only selectors are accepted: arbitrary xcodebuild options could replace the
# isolated project/scheme or add a personal device as a second destination.
for selector in "$@"; do
  case "$selector" in
    -only-testing:?*|-skip-testing:?*) ;;
    *) echo "Only -only-testing:... / -skip-testing:... selectors are supported: $selector" >&2; exit 2 ;;
  esac
done
if [[ "${KRAKI_ALLOW_TEST_MICROPHONE:-0}" == 1 || "${SIMCTL_CHILD_KRAKI_ALLOW_TEST_MICROPHONE:-0}" == 1 ]]; then
  echo 'This runner is hardware-free. Use a separately authorized manual device session for microphone acceptance.' >&2
  exit 2
fi
repo="$(cd "$(dirname "$0")/.." && pwd)"
ios="$repo/packages/arm/ios"
if [[ "$platform" == ios ]]; then
  : "${KRAKI_TEST_SIMULATOR:?Set KRAKI_TEST_SIMULATOR to a dedicated iPhone Simulator UUID}"
  destination="platform=iOS Simulator,id=$KRAKI_TEST_SIMULATOR"
  scheme=Kraki
else
  destination='platform=macOS'
  scheme=KrakiMacTests
fi
work="$(mktemp -d /tmp/kraki-native-test.XXXXXX)"
mkdir -p "$work/home" "$work/project"
python3 - "$ios" "$work" "$platform" "${KRAKI_TEST_SIMULATOR:-}" <<'PY'
from pathlib import Path
import json, subprocess, sys
root, work = Path(sys.argv[1]), Path(sys.argv[2])
if sys.argv[3] == 'ios':
    devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))['devices']
    assert any(d['udid'] == sys.argv[4] and 'iPhone' in d.get('deviceTypeIdentifier', d['name']) for group in devices.values() for d in group), 'Use an available dedicated iPhone Simulator'
spec = (root / 'project.yml').read_text()
spec = spec.replace('chat.kraki.ios', 'chat.kraki.testscope.ios').replace('chat.kraki.mac', 'chat.kraki.testscope.mac')
spec = spec.replace('/tmp/kraki-mac-tests-data', str(work / 'data'))
(work / 'project.yml').write_text(spec)
# Build-setting paths are relative to PROJECT_DIR rather than the source root.
for path in root.iterdir():
    if path.name.startswith('Kraki') and not path.name.endswith('.xcodeproj'):
        (work / 'project' / path.name).symlink_to(path, target_is_directory=path.is_dir())
PY
xcodegen generate --spec "$work/project.yml" --project-root "$ios" --project "$work/project"
args=(-project "$work/project/Kraki.xcodeproj" -scheme "$scheme"
      -destination "$destination" -derivedDataPath "$work/derived"
      -parallel-testing-enabled NO -resultBundlePath "$work/result.xcresult")
if [[ -n "${KRAKI_SOURCE_PACKAGES_DIR:-}" ]]; then
  args+=(-clonedSourcePackagesDirPath "$KRAKI_SOURCE_PACKAGES_DIR" -disableAutomaticPackageResolution -skipPackageUpdates)
fi
printf 'Isolated test evidence: %s\n' "$work"
# Forward only validated test selectors, never arbitrary xcodebuild overrides.
env -u KRAKI_HOME -u KRAKI_ALLOW_TEST_MICROPHONE -u SIMCTL_CHILD_KRAKI_ALLOW_TEST_MICROPHONE HOME="$work/home" \
  xcodebuild "${args[@]}" "$@" KRAKI_RUN_PERF_TESTS="$perf" KRAKI_RUN_UI_TESTS="${KRAKI_RUN_UI_TESTS:-0}" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_ENTITLEMENTS= test \
  >"$work/test.log" 2>&1 || { tail -80 "$work/test.log"; exit 1; }
tail -15 "$work/test.log"
printf 'Passed. Evidence retained: %s\n' "$work"
