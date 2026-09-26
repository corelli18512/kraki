#!/bin/bash
# Native iPhone hold-to-text gate. Independent bundle IDs, temporary HOME/project,
# synthetic audio/transport and a caller-selected Simulator. Never launches macOS.
set -euo pipefail
: "${KRAKI_TEST_SIMULATOR:?Set KRAKI_TEST_SIMULATOR to a dedicated iPhone Simulator UUID}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
ios="$repo/packages/arm/ios"
work="$(mktemp -d /tmp/kraki-ios-voice-hold.XXXXXX)"
mkdir -p "$work/home" "$work/project"
python3 - "$ios" "$work" "$KRAKI_TEST_SIMULATOR" <<'PY'
from pathlib import Path
import json, subprocess, sys
root, work, device = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))['devices']
assert any(d['udid'] == device and 'iPhone' in d.get('deviceTypeIdentifier', d['name']) for group in devices.values() for d in group), 'Use an available iPhone Simulator (not a physical device)'
spec = (root / 'project.yml').read_text().replace('name: Kraki\n', 'name: KrakiVoiceHoldIsolated\n', 1).replace('chat.kraki.ios', 'chat.kraki.design.hold-c')
spec = spec.replace('      targets:\n        - KrakiTests', '      environmentVariables:\n        KRAKI_IOS_CHAT_ALIGNMENT_PREVIEW: "1"\n      targets:\n        - KrakiTests', 1)
(work / 'project.yml').write_text(spec)
for name in ['Kraki', 'KrakiNotification']:
    (work / 'project' / name).symlink_to(root / name, target_is_directory=True)
PY
xcodegen generate --spec "$work/project.yml" --project-root "$ios" --project "$work/project"
args=(-project "$work/project/KrakiVoiceHoldIsolated.xcodeproj"
      -destination "platform=iOS Simulator,id=$KRAKI_TEST_SIMULATOR"
      -derivedDataPath "$work/derived" -parallel-testing-enabled NO
      CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_ENTITLEMENTS=)
if [[ -n "${KRAKI_SOURCE_PACKAGES_DIR:-}" ]]; then
    args+=(-clonedSourcePackagesDirPath "$KRAKI_SOURCE_PACKAGES_DIR" -disableAutomaticPackageResolution -skipPackageUpdates)
fi
printf 'Evidence retained at %s\n' "$work"
env -u KRAKI_HOME HOME="$work/home" xcodebuild "${args[@]}" -scheme Kraki -resultBundlePath "$work/unit.xcresult" test >"$work/unit.log" 2>&1
env -u KRAKI_HOME HOME="$work/home" xcodebuild "${args[@]}" -scheme KrakiVoiceHold -resultBundlePath "$work/ui.xcresult" test >"$work/ui.log" 2>&1
printf 'Passed. Evidence: %s\n' "$work"
