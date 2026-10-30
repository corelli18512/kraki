#!/bin/bash
# apple-retry.sh <command...> — run an Apple notary/stapler command, retrying
# only on transient network failures (connection lost / timed out / offline),
# which Apple's ticket service (api.apple-cloudkit.com) returns intermittently.
# Any other failure (an invalid ticket, a rejected submission) fails at once.
set -uo pipefail
attempts="${APPLE_RETRY_ATTEMPTS:-5}"
delay="${APPLE_RETRY_DELAY:-15}"
for ((i = 1; i <= attempts; i++)); do
  out="$("$@" 2>&1)"; status=$?
  printf '%s\n' "$out"
  [ "$status" -eq 0 ] && exit 0
  if ! grep -qE 'NSURLErrorDomain Code=-(1001|1005|1009|1004)|network connection was lost|timed out|Could not connect|offline' <<<"$out"; then
    exit "$status"
  fi
  [ "$i" -lt "$attempts" ] && { echo "::warning::$1 $2: transient Apple network error (attempt $i/$attempts); retrying in ${delay}s"; sleep "$delay"; delay=$((delay * 2)); }
done
echo "::error::$1 $2 still failing after $attempts attempts"
exit "$status"
