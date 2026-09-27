#!/bin/bash
# Compatibility entry point. The collector and deployment now belong to @kraki/monitor.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$ROOT/packages/monitor/scripts/deploy.sh" "$@"
