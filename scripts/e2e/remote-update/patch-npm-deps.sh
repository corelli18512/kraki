#!/bin/bash
# CI-only old-version fixture: patch runtime files, exports and dependencies.
set -euo pipefail
node "$(dirname "$0")/patch-npm-deps.mjs"
