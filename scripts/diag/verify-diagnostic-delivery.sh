#!/bin/bash
# Only an explicit DiagnosticsDelivery release may use the existing app identity.
set -euo pipefail
python3 - "${1:?usage: verify-diagnostic-delivery.sh App.app}" <<'PY'
import pathlib, plistlib, subprocess, sys
app = pathlib.Path(sys.argv[1])
mac = (app/'Contents').exists()
meta = plistlib.loads((app/('Contents/Info.plist' if mac else 'Info.plist')).read_bytes())
assert meta['CFBundleIdentifier'] == ('chat.kraki.mac' if mac else 'chat.kraki.ios')
binary = (app/'Contents/MacOS' if mac else app)/meta['CFBundleExecutable']
s = subprocess.check_output(['/usr/bin/strings', str(binary)])
# Swift may encode <=15-byte literals inside instructions (small-string ABI).
# These long, live-code markers remain addressable cstrings in optimized builds.
for marker in (b'KrakiDiag.interaction', b'kraki.diag.enabled'):
    assert marker in s, f'Diagnostic delivery lacks {marker!r}'
assert (b'chat.kraki.mac.signing-key' if mac else b'chat.kraki.ios.signing-key') in s
assert b'group.chat.kraki.ios.diag' not in s, 'Wrong storage identity'
print('PASS: explicit diagnostic delivery, existing identity, collector + user toggle present')
PY
