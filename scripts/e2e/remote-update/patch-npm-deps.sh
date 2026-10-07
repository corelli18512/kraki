#!/bin/bash
# Run this repo's protocol/crypto code in a globally npm-installed tentacle.
# The packed tentacle depends on the published protocol/crypto, which main
# may be ahead of. Re-run after every reinstall of the old artifact.
set -euo pipefail
ROOT="$(npm root -g)"
for pkg in protocol crypto; do
  for P in "$ROOT/@kraki/tentacle/node_modules/@kraki/$pkg" "$ROOT/@kraki/$pkg"; do
    if [ -d "$P" ]; then cp -R "packages/$pkg/dist/." "$P/dist/"; echo "patched $P"; fi
  done
done
