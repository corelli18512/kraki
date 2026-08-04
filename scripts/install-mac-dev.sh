#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IOS_ROOT="$REPO_ROOT/packages/arm/ios"
PROJECT="$IOS_ROOT/Kraki.xcodeproj"
DERIVED_DATA="${KRAKI_MAC_DEV_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/KrakiDevLocal}"
BUILT_APP="$DERIVED_DATA/Build/Products/Debug/Kraki Dev.app"
DEV_APP="/Applications/Kraki Dev.app"
PROD_APP="/Applications/Kraki.app"
DEV_BUNDLE_ID="chat.kraki.mac.dev"
PROD_BUNDLE_ID="chat.kraki.mac"
TEAM_ID="3A83X5JZ3S"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
RESET_MICROPHONE=0
LAUNCH_APP=1

usage() {
  cat <<'EOF'
Usage: scripts/install-mac-dev.sh [options]

Build, verify, and atomically install the isolated Kraki Dev app.

Options:
  --reset-microphone  Reset only chat.kraki.mac.dev microphone permission.
  --no-launch         Install and register the app without launching it.
  -h, --help          Show this help.

The destination is fixed at /Applications/Kraki Dev.app. This script never
replaces, terminates, signs, or modifies /Applications/Kraki.app.
EOF
}

while (($#)); do
  case "$1" in
    --reset-microphone)
      RESET_MICROPHONE=1
      ;;
    --no-launch)
      LAUNCH_APP=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

prod_pid() {
  pgrep -f '^/Applications/Kraki\.app/Contents/MacOS/Kraki$' | head -1 || true
}

dev_pids() {
  ps -axo pid=,command= | awk '/\/Kraki Dev\.app\/Contents\/MacOS\/Kraki Dev$/ { print $1 }'
}

verify_dev_app() {
  local app=$1
  local bundle_id display_name executable icon_name authority team_id

  test -d "$app"
  bundle_id=$(plist_value "$app" CFBundleIdentifier)
  display_name=$(plist_value "$app" CFBundleDisplayName)
  executable=$(plist_value "$app" CFBundleExecutable)
  icon_name=$(plist_value "$app" CFBundleIconName)

  test "$bundle_id" = "$DEV_BUNDLE_ID" || {
    echo "Refusing to install unexpected bundle id: $bundle_id" >&2
    return 1
  }
  test "$display_name" = "Kraki (Dev)" || {
    echo "Refusing to install unexpected display name: $display_name" >&2
    return 1
  }
  test "$executable" = "Kraki Dev" || {
    echo "Refusing to install unexpected executable: $executable" >&2
    return 1
  }
  test "$icon_name" = "DevAppIcon" || {
    echo "Refusing to install unexpected icon: $icon_name" >&2
    return 1
  }
  test -f "$app/Contents/Resources/DevAppIcon.icns"

  codesign --verify --deep --strict --verbose=2 "$app"
  authority=$(codesign -dv --verbose=4 "$app" 2>&1 | awk -F= '/^Authority=Apple Development:/ { print $2 }')
  team_id=$(codesign -dv --verbose=4 "$app" 2>&1 | awk -F= '/^TeamIdentifier=/ { print $2 }')
  test -n "$authority" || {
    echo "Refusing to install a Dev app without an Apple Development signature" >&2
    return 1
  }
  test "$team_id" = "$TEAM_ID" || {
    echo "Refusing to install a Dev app signed by team $team_id" >&2
    return 1
  }
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Kraki Dev installation is supported only on macOS." >&2
  exit 1
fi

if [[ "$DEV_APP" == "$PROD_APP" || "$DEV_BUNDLE_ID" == "$PROD_BUNDLE_ID" ]]; then
  echo "Internal safety check failed: Dev and Prod identities overlap." >&2
  exit 1
fi

PROD_HASH_BEFORE=""
PROD_PID_BEFORE=""
if [[ -d "$PROD_APP" ]]; then
  test "$(plist_value "$PROD_APP" CFBundleIdentifier)" = "$PROD_BUNDLE_ID"
  PROD_HASH_BEFORE=$(sha256_file "$PROD_APP/Contents/MacOS/Kraki")
  PROD_PID_BEFORE=$(prod_pid)
fi

printf 'Building Kraki Dev with isolated DerivedData...\n'
xcodebuild \
  -project "$PROJECT" \
  -scheme KrakiMac \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED_DATA" \
  build

printf 'Verifying Debug product identity, icon, and signature...\n'
verify_dev_app "$BUILT_APP"

printf 'Stopping only running Kraki Dev processes...\n'
RUNNING_DEV_PIDS=$(dev_pids)
if [[ -n "$RUNNING_DEV_PIDS" ]]; then
  # PID output is numeric and whitespace-separated by ps/awk.
  # shellcheck disable=SC2086
  kill -TERM $RUNNING_DEV_PIDS
  for _ in $(seq 1 40); do
    RUNNING_DEV_PIDS=$(dev_pids)
    [[ -z "$RUNNING_DEV_PIDS" ]] && break
    sleep 0.25
  done
  RUNNING_DEV_PIDS=$(dev_pids)
  if [[ -n "$RUNNING_DEV_PIDS" ]]; then
    echo "Kraki Dev did not exit cleanly; refusing to replace it." >&2
    exit 1
  fi
fi

CACHE_ROOT="$HOME/Library/Caches/KrakiDevInstaller"
ROLLBACK_APP="$CACHE_ROOT/Previous Kraki Dev.app"
mkdir -p "$CACHE_ROOT"
rm -rf "$ROLLBACK_APP"

STAGE_DIR=$(mktemp -d "/Applications/.kraki-dev-install.XXXXXX")
trap 'rm -rf "$STAGE_DIR"' EXIT
STAGED_APP="$STAGE_DIR/Kraki Dev.app"
ditto "$BUILT_APP" "$STAGED_APP"
verify_dev_app "$STAGED_APP"

if [[ -e "$DEV_APP" ]]; then
  mv "$DEV_APP" "$ROLLBACK_APP"
fi

if ! mv "$STAGED_APP" "$DEV_APP"; then
  if [[ -e "$ROLLBACK_APP" ]]; then
    mv "$ROLLBACK_APP" "$DEV_APP"
  fi
  echo "Failed to install Kraki Dev; restored the previous Dev app." >&2
  exit 1
fi

if ! verify_dev_app "$DEV_APP"; then
  rm -rf "$DEV_APP"
  if [[ -e "$ROLLBACK_APP" ]]; then
    mv "$ROLLBACK_APP" "$DEV_APP"
  fi
  echo "Installed Dev app failed verification; restored the previous Dev app." >&2
  exit 1
fi

# xcodebuild registers its DerivedData product automatically. Once the verified
# copy is installed, remove that transient registration and product so TCC,
# Spotlight, and LaunchServices resolve exactly one Dev app at the fixed path.
"$LSREGISTER" -u "$BUILT_APP" 2>/dev/null || true
rm -rf "$BUILT_APP"
"$LSREGISTER" -f "$DEV_APP"

if ((RESET_MICROPHONE)); then
  printf 'Resetting microphone permission only for %s...\n' "$DEV_BUNDLE_ID"
  tccutil reset Microphone "$DEV_BUNDLE_ID"
fi

if [[ -d "$PROD_APP" ]]; then
  PROD_HASH_AFTER=$(sha256_file "$PROD_APP/Contents/MacOS/Kraki")
  PROD_PID_AFTER=$(prod_pid)
  test "$PROD_HASH_AFTER" = "$PROD_HASH_BEFORE" || {
    echo "Prod binary changed unexpectedly; stopping." >&2
    exit 1
  }
  test "$PROD_PID_AFTER" = "$PROD_PID_BEFORE" || {
    echo "Prod process changed unexpectedly; stopping." >&2
    exit 1
  }
fi

if ((LAUNCH_APP)); then
  printf 'Launching the fixed Dev channel...\n'
  ENV_ARGS=()
  while IFS='=' read -r name _; do
    [[ "$name" == KRAKI_* ]] && ENV_ARGS+=( -u "$name" )
  done < <(env)
  env "${ENV_ARGS[@]}" open "$DEV_APP"

  DEV_PID=""
  for _ in $(seq 1 60); do
    DEV_PID=$(pgrep -f '^/Applications/Kraki Dev\.app/Contents/MacOS/Kraki Dev$' | head -1 || true)
    [[ -n "$DEV_PID" ]] && break
    sleep 0.25
  done
  test -n "$DEV_PID" || {
    echo "Kraki Dev did not launch from $DEV_APP" >&2
    exit 1
  }
  printf 'Kraki Dev is running as PID %s.\n' "$DEV_PID"
fi

printf 'Installed: %s\n' "$DEV_APP"
printf 'Bundle ID: %s\n' "$DEV_BUNDLE_ID"
printf 'Prod untouched: %s\n' "$PROD_APP"
