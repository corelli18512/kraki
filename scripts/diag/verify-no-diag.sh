#!/bin/bash
# Fail closed on a production .app before signing/export/upload. Never deletes it.
set -euo pipefail
APP="${1:?usage: verify-no-diag.sh path/to/Production.app}"
python3 - "$APP" <<'PY'
import pathlib, plistlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
assert root.is_dir(), f'Missing app: {root}'
bundles = [root, *root.rglob('*.appex')]
for bundle in bundles:
    info = bundle / 'Contents/Info.plist' if (bundle / 'Contents').exists() else bundle / 'Info.plist'
    with info.open('rb') as f: meta = plistlib.load(f)
    assert '.diag' not in meta.get('CFBundleIdentifier', ''), f'Diagnostic identity: {bundle}'
    binary = (bundle / 'Contents/MacOS' if (bundle / 'Contents').exists() else bundle) / meta['CFBundleExecutable']
    assert binary.is_file(), f'Missing executable: {binary}'
    strings = subprocess.check_output(['/usr/bin/strings', str(binary)], stderr=subprocess.STDOUT)
    # Stable live-code markers, not a sole reliance on stripped Swift symbols.
    forbidden = (b'kraki-diag-v1', b'/api/diag/v1/', b'KrakiDiag.interaction', b'kraki.diag.enabled')
    assert not any(s in strings for s in forbidden), f'Diagnostics code in production: {binary}'
print(f'PASS: production isolation ({len(bundles)} binaries)')
PY
