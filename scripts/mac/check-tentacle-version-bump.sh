#!/usr/bin/env bash
# Fail a Kraki for Mac release whose built-in tentacle changed since the
# previous mac-v* release while its version stayed the same.
#
# Why: the app restarts the background daemon after a Sparkle update when the
# shipped tentacle version differs from the running one. mac-v0.2.90 shipped a
# rebuilt helper still versioned 0.38.10, the daemon kept running the deleted
# old binary, and macOS then denied every agent access to Documents/Desktop
# (tccd could not resolve the responsible process's executable).
#
# Usage: check-tentacle-version-bump.sh [release-ref]   (default HEAD)
set -euo pipefail

REF="${1:-HEAD}"
PREV="$(git describe --tags --match 'mac-v*' --abbrev=0 "${REF}^" 2>/dev/null || true)"
if [ -z "$PREV" ]; then
  echo "No previous mac-v* tag before $REF; nothing to compare."
  exit 0
fi

version_at() {
  git show "$1:packages/tentacle/package.json" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'
}

# The helper's sources and its build script (tests and docs excluded).
# pnpm-lock.yaml is not watched: most of its changes are other packages'
# dependencies. A helper rebuilt only for a dependency at the same version is
# caught at runtime instead: the app restarts a daemon whose executable was
# deleted by the update (TentacleCLIManager.staleDaemonBinary).
PATHS=(
  packages/tentacle packages/protocol packages/crypto packages/pulse
  scripts/mac/build-tentacle-helper.sh
  ':(exclude)**/__tests__/**' ':(exclude)**/*.test.ts' ':(exclude)**/*.md'
)

PREV_VERSION="$(version_at "$PREV")"
CUR_VERSION="$(version_at "$REF")"
CHANGED="$(git diff --name-only "$PREV" "$REF" -- "${PATHS[@]}")"

if [ -n "$CHANGED" ] && [ "$PREV_VERSION" = "$CUR_VERSION" ]; then
  echo "::error::Tentacle code changed since $PREV but its version is still $CUR_VERSION."
  echo "Bump packages/tentacle/package.json (and release the tentacle) so Kraki for Mac"
  echo "restarts the running daemon after the update. Changed files:"
  echo "$CHANGED" | sed 's/^/  /'
  exit 1
fi
echo "Tentacle $PREV_VERSION ($PREV) -> $CUR_VERSION ($REF): ok"
