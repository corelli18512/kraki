#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
D="$ROOT/design/compacting-80"
OUT="${1:-${TMPDIR:-/tmp}/kraki-status-icons-v3}"
mkdir -p "$OUT"
python3 - "$ROOT" "$OUT" <<'PY'
import sys, subprocess, pathlib, hashlib, json
root, out = map(pathlib.Path, sys.argv[1:])
core = root/'packages/arm/ios/Kraki/Core/Protocol'
base = subprocess.check_output(['git','show','mac-v0.2.62:packages/arm/ios/Kraki/Core/Protocol/SessionPreviewGlyphLayer.swift'],cwd=root).decode()
(out/'Baseline.swift').write_text(base.replace('SessionCompactingGeometry','BaselineCompactingGeometry').replace('SessionPreviewGlyphLayer','BaselinePreviewGlyphLayer').replace('SessionPreviewGlyphKind','BaselinePreviewGlyphKind'))
previous = (root/'design/compacting-80/PreviousGlyphSource.swift').read_text()
(out/'Previous.swift').write_text(previous.replace('SessionCompactingGeometry','PreviousCompactingGeometry').replace('SessionPreviewGlyphLayer','PreviousPreviewGlyphLayer').replace('SessionPreviewGlyphKind','PreviousPreviewGlyphKind'))
# Extract exact production platform color initializer and delivery enum.
platform = (root/'packages/arm/ios/Kraki/Shared/KrakiPlatform.swift').read_text()
colors = platform[platform.index('extension Color {'):platform.index('\n#endif\n\n// MARK: - Pasteboard')]
enum = (core/'SessionPendingPreview.swift').read_text().split('struct SessionPendingPreview:')[0]
(out/'Support.swift').write_text('import AppKit\nimport SwiftUI\ntypealias PlatformColor = NSColor\n'+colors+'\n'+enum)
sidebar = root/'packages/arm/ios/Kraki/Features/Sessions/SessionsSidebarView+macOS.swift'
import re
source = sidebar.read_text()
metrics = (core/'SessionPreviewGlyphLayer.swift').read_text()
ios = (core/'SessionCardPresentation.swift').read_text()
for icon, key, size, factor, stroke in [('botMessageSquare', 'agentSize', 13, 1.20, 1.9), ('circleUser', 'humanSize', 13, 1.10, 1.9), ('shieldQuestion', 'approvalSize', 14, 1.10, 2.2)]:
    pattern = r'LucideIcon\(\.'+icon+r',\s+size: SessionStatusGlyphMetrics\.'+key+r',\s+strokeWidth: '+re.escape(str(stroke))+','
    assert re.search(pattern, source) and re.search(pattern, ios), f'{icon}: shared metric missing'
    match = re.search(r'static let '+key+r': CGFloat = '+str(size)+r' \* ([\d.]+)', metrics)
    assert match and float(match[1]) == factor, f'{icon}: production/preview size mismatch'
    assert size*factor <= 16, 'Glyph exceeds existing 16pt slot'
print('PASS: assistant/user unchanged at 15.6/14.3pt; authorization 15.4pt (+10%); all fit 16pt slots')
files = [core/'SessionPreviewGlyphLayer.swift', root/'packages/arm/ios/Kraki/Shared/LucideIcon.swift', root/'packages/arm/ios/Kraki/Shared/ThemePlatform.swift', sidebar, root/'design/compacting-80/Preview.swift']
(out/'provenance.json').write_text(json.dumps({'baseline':'V2: exact prior renderer captured in PreviousGlyphSource.swift; bottom row adds compacting 1.20x/1.10y and authorization 1.10; assistant/user unchanged' ,'base_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip(),'renderer':'Production CALayer render(in:) at matching expanded phase; SwiftUI ImageRenderer; native Lucide and SF neighbors; not a full session-row screenshot','files':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}},indent=2))
PY
xcrun swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macos15.0 \
  "$ROOT/packages/arm/ios/Kraki/Core/Protocol/SessionPreviewGlyphLayer.swift" \
  "$ROOT/packages/arm/ios/Kraki/Shared/LucideIcon.swift" \
  "$ROOT/packages/arm/ios/Kraki/Shared/ThemePlatform.swift" \
  "$OUT/Baseline.swift" "$OUT/Previous.swift" "$OUT/Support.swift" "$D/Preview.swift" \
  -o "$OUT/Preview"
"$OUT/Preview" "$OUT/comparison.png" | tee "$OUT/checks.txt"
