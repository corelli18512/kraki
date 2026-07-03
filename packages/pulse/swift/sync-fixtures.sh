#!/usr/bin/env bash
# Copy the canonical wire fixtures into the Swift test bundle.
#
# fixtures/wire.json is the single source of truth (also consumed directly by
# the TS suite). SwiftPM resource bundling does not follow symlinks, so the
# Swift tests need a real copy. Run this after editing the fixtures.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../fixtures/wire.json"
dst="$here/Tests/PulseTests/wire.json"
cp "$src" "$dst"
echo "synced $src -> $dst"
