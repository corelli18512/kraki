#!/bin/sh
# Kraki installer — https://app.kraki.chat
# Usage: curl -fsSL https://app.kraki.chat/install.sh | bash
set -e

REPO="corelli18512/kraki"
INSTALL_DIR="${HOME}/.local/bin"
BINARY_NAME="kraki"

# ── Detect platform ──────────────────────────────────────

detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  case "$OS" in
    darwin)  PLATFORM="macos" ;;
    linux)   PLATFORM="linux" ;;
    mingw*|msys*|cygwin*) PLATFORM="windows" ;;
    *)       echo "Error: Unsupported OS: $OS"; exit 1 ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)             echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
  esac

  if [ "$PLATFORM" = "windows" ]; then
    ASSET="kraki-cli-${PLATFORM}-${ARCH}.exe"
    BINARY_NAME="kraki.exe"
  elif [ "$PLATFORM" = "macos" ]; then
    # macOS: install as .app bundle so TCC/FDA grants survive binary updates
    ASSET="kraki-macos-${ARCH}.app.tar.gz"
    APP_BUNDLE=1
  else
    ASSET="kraki-cli-${PLATFORM}-${ARCH}"
  fi
}

# ── Fetch latest version ─────────────────────────────────

fetch_latest_version() {
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
  if [ -z "$VERSION" ]; then
    echo "Error: Could not determine latest version"
    exit 1
  fi
}

# ── Download and install ─────────────────────────────────

install() {
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
  TMP=$(mktemp -d)

  echo "  Installing Kraki ${VERSION} (${PLATFORM}/${ARCH})..."

  if ! curl -fSL# -o "${TMP}/${ASSET}" "$URL"; then
    echo "Error: Download failed — ${URL}"
    rm -rf "$TMP"
    exit 1
  fi

  # macOS: install as .app bundle with a symlink in $INSTALL_DIR
  if [ "${APP_BUNDLE:-}" = "1" ]; then
    install_app_bundle "$TMP"
    rm -rf "$TMP"
    return
  fi

  TARGET="${TMP}/${BINARY_NAME}"
  mv "${TMP}/${ASSET}" "$TARGET"
  chmod +x "$TARGET"

  # Windows (Git Bash): install to user's local bin
  if [ "$PLATFORM" = "windows" ]; then
    INSTALL_DIR="${HOME}/bin"
    mkdir -p "$INSTALL_DIR"
    mv "$TARGET" "${INSTALL_DIR}/${BINARY_NAME}"
    echo "  Installed to ${INSTALL_DIR}/${BINARY_NAME}"
    rm -rf "$TMP"
    return
  fi

  # --global flag: install to /usr/local/bin (requires sudo if not writable)
  if [ "${KRAKI_INSTALL_GLOBAL:-}" = "1" ]; then
    INSTALL_DIR="/usr/local/bin"
  fi

  mkdir -p "$INSTALL_DIR"

  # macOS / Linux: install to user-writable dir, sudo fallback for --global
  if [ -w "$INSTALL_DIR" ]; then
    mv "$TARGET" "${INSTALL_DIR}/${BINARY_NAME}"
    echo "  Installed to ${INSTALL_DIR}/${BINARY_NAME}"
  elif command -v sudo >/dev/null 2>&1; then
    echo "  Installing to ${INSTALL_DIR} (requires sudo)..."
    sudo mv "$TARGET" "${INSTALL_DIR}/${BINARY_NAME}"
    echo "  Installed to ${INSTALL_DIR}/${BINARY_NAME}"
  else
    echo "  Error: ${INSTALL_DIR} is not writable and sudo is not available"
    rm -rf "$TMP"
    exit 1
  fi

  ensure_path_configured

  rm -rf "$TMP"
}

# ── macOS .app bundle install ────────────────────────────

install_app_bundle() {
  TMP="$1"
  APP_HOME="${HOME}/.local/share/kraki"
  APP_PATH="${APP_HOME}/Kraki.app"

  # Extract .app bundle
  mkdir -p "$APP_HOME"
  rm -rf "$APP_PATH"
  tar -xzf "${TMP}/${ASSET}" -C "$APP_HOME"

  # Strip quarantine/provenance xattrs
  xattr -cr "$APP_PATH" 2>/dev/null || true

  chmod +x "$APP_PATH/Contents/MacOS/kraki"

  # Register the bundle with Launch Services so macOS TCC tracks the
  # app by bundle id (stable across updates) instead of cdhash (which
  # changes every release and invalidates all TCC grants). This is the
  # root-cause fix for the recurring "kraki lost its permissions" bug.
  # Best-effort; the daemon also re-registers on startup and after self-update.
  if [ -x "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister" ]; then
    /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$APP_PATH" 2>/dev/null || true
  fi

  # --global flag: install symlink to /usr/local/bin
  if [ "${KRAKI_INSTALL_GLOBAL:-}" = "1" ]; then
    INSTALL_DIR="/usr/local/bin"
  fi

  mkdir -p "$INSTALL_DIR"

  # Remove existing binary/symlink and create symlink to the .app binary
  LINK_TARGET="${INSTALL_DIR}/${BINARY_NAME}"
  rm -f "$LINK_TARGET" 2>/dev/null || true
  ln -sf "$APP_PATH/Contents/MacOS/kraki" "$LINK_TARGET"

  echo "  Installed to ${APP_PATH}"
  echo "  Symlinked ${LINK_TARGET} → .app bundle"

  ensure_path_configured
}

# ── PATH configuration ───────────────────────────────────

ensure_path_configured() {
  case ":$PATH:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      # Add to the shell profile automatically; only ask the user when that fails.
      SHELL_NAME=$(basename "${SHELL:-/bin/sh}")
      PROFILE=""
      case "$SHELL_NAME" in
        # macOS ships zsh without a ~/.zshrc; create it so `kraki` works in new shells.
        zsh)  PROFILE="$HOME/.zshrc"; [ -f "$PROFILE" ] || : > "$PROFILE" ;;
        bash)
          if [ -f "$HOME/.bash_profile" ]; then PROFILE="$HOME/.bash_profile"
          elif [ -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.bashrc"
          fi ;;
      esac
      if [ -n "$PROFILE" ] && [ -f "$PROFILE" ]; then
        if ! grep -q "${INSTALL_DIR}" "$PROFILE" 2>/dev/null; then
          printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$PROFILE"
        fi
        echo "  Added ${INSTALL_DIR} to PATH in ${PROFILE}. Open a new Terminal window to use kraki."
      else
        echo "  ⚠  Add to PATH:  export PATH=\"\$PATH:${INSTALL_DIR}\""
      fi
      ;;
  esac
}

# ── Kraki for Mac already installed? ────────────────────
#
# Kraki for Mac (with its built-in tentacle) sets up and runs Kraki by itself,
# so this install would be a second copy. Ask before downloading anything.
# KRAKI_INSTALL_FORCE=1 skips the question for scripted installs.

MAC_APP=""
MAC_APP_MANAGED=0

detect_mac_app() {
  for app in "/Applications/Kraki.app" "${HOME}/Applications/Kraki.app"; do
    # "Kraki.app" since the helper rename; "Kraki Tentacle.app" before it.
    if [ -x "${app}/Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki" ] \
      || [ -x "${app}/Contents/Library/Helpers/Kraki Tentacle.app/Contents/MacOS/kraki" ]; then
      MAC_APP="$app"
      break
    fi
  done
  MARKER="${HOME}/.kraki/managed-by.json"
  if grep -q '"kraki-mac"' "$MARKER" 2>/dev/null; then
    # Stale if the app it names was deleted (the CLI ignores it then, too).
    MARKER_APP=$(sed -n 's/.*"appPath"[^"]*"\([^"]*\)".*/\1/p' "$MARKER" | sed 's#\\/#/#g' | head -1)
    if [ -z "$MARKER_APP" ] || [ -d "$MARKER_APP" ]; then
      MAC_APP_MANAGED=1
    fi
  fi
}

confirm_despite_mac_app() {
  [ "$PLATFORM" = "macos" ] || return 0
  detect_mac_app
  if [ -z "$MAC_APP" ] && [ "$MAC_APP_MANAGED" = 0 ]; then
    return 0
  fi
  [ "${KRAKI_INSTALL_FORCE:-}" = "1" ] && return 0

  if [ "$MAC_APP_MANAGED" = 1 ]; then
    echo "  ⚠ Kraki for Mac already runs Kraki on this Mac."
    echo "    You don't need to install it again."
    echo "    If you continue, you get the kraki command for Terminal. Kraki for Mac"
    echo "    keeps running Kraki in the background."
  else
    echo "  ⚠ Kraki for Mac is installed (${MAC_APP})."
    echo "    It sets up Kraki and runs it in the background by itself, so you"
    echo "    don't need this install. Open Kraki from Applications instead."
  fi
  echo ""
  printf "  Install the command-line version anyway? [y/N] "
  answer=""
  { read -r answer </dev/tty; } 2>/dev/null || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) echo "" ;;
    *)
      echo ""
      echo "  Nothing was installed."
      echo ""
      exit 0
      ;;
  esac
}

# ── Main ─────────────────────────────────────────────────

main() {
  echo ""
  echo "  🦑 Kraki Installer"
  echo ""

  detect_platform
  confirm_despite_mac_app
  fetch_latest_version
  install

  echo ""
  echo "  ✓ Kraki ${VERSION} installed"
  echo ""

  if [ "$MAC_APP_MANAGED" = 1 ]; then
    # Kraki for Mac owns the background service and the sign-in; the CLI
    # defers to it, so there is nothing to set up or start here.
    echo "  Kraki for Mac keeps running Kraki. Try: kraki status"
    echo ""
    return 0
  fi

  # Auto-run interactive setup. KRAKI_INSTALL=1 tells kraki to complete
  # configuration but exit before daemon startup or pairing output. The
  # subsequent `kraki start` uses the same background-only daemon manager,
  # manager, readiness handshake, Launch Services validation, and error path as
  # `kraki start` / `kraki restart`.
  KRAKI_INSTALL=1 "${INSTALL_DIR}/${BINARY_NAME}" </dev/tty

  echo "  Starting Kraki daemon..."
  "${INSTALL_DIR}/${BINARY_NAME}" start
  echo ""
}

main
