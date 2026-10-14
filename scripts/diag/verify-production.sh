#!/bin/bash
# Fail closed on a production .app before signing/export/upload. Never deletes it.
#
# Production records experience metrics (KrakiDiag, user can turn it off) with
# the normal app identity, and must not carry test-build identity or test-only UI.
set -euo pipefail
APP="${1:?usage: verify-production.sh path/to/Production.app}"
python3 - "$APP" <<'PY'
import pathlib, plistlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
assert root.is_dir(), f'Missing app: {root}'
mac = (root / 'Contents').exists()
bundles = [root, *root.rglob('*.appex')]
for bundle in bundles:
    info = bundle / 'Contents/Info.plist' if (bundle / 'Contents').exists() else bundle / 'Info.plist'
    with info.open('rb') as f: meta = plistlib.load(f)
    assert '.diag' not in meta.get('CFBundleIdentifier', ''), f'Diagnostic identity: {bundle}'
    binary = (bundle / 'Contents/MacOS' if (bundle / 'Contents').exists() else bundle) / meta['CFBundleExecutable']
    assert binary.is_file(), f'Missing executable: {binary}'
    strings = subprocess.check_output(['/usr/bin/strings', str(binary)], stderr=subprocess.STDOUT)
    assert b'group.chat.kraki.ios.diag' not in strings, f'Test-build storage identity: {binary}'
    assert b'Diagnostics \xc2\xb7 Test Build' not in strings, f'Test-build diagnostics UI in production: {binary}'
    if bundle == root:
        # Long live-code markers stay addressable cstrings in optimized builds.
        for marker in (b'KrakiDiag.interaction', b'kraki.diag.enabled', b'Share Performance Data'):
            assert marker in strings, f'Production lacks experience metrics ({marker!r}): {binary}'
        assert (b'chat.kraki.mac.signing-key' if mac else b'chat.kraki.ios.signing-key') in strings, 'Wrong signing identity'
print(f'PASS: production build, normal identity, experience metrics present ({len(bundles)} binaries)')
PY
