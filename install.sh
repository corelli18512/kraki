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
      echo "  ⚠  Add to PATH:  export PATH=\"\$PATH:${INSTALL_DIR}\""
      # Try to add to shell profile automatically
      SHELL_NAME=$(basename "${SHELL:-/bin/sh}")
      PROFILE=""
      case "$SHELL_NAME" in
        zsh)  PROFILE="$HOME/.zshrc" ;;
        bash)
          if [ -f "$HOME/.bash_profile" ]; then PROFILE="$HOME/.bash_profile"
          elif [ -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.bashrc"
          fi ;;
      esac
      if [ -n "$PROFILE" ] && [ -f "$PROFILE" ]; then
        if ! grep -q "${INSTALL_DIR}" "$PROFILE" 2>/dev/null; then
          printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$PROFILE"
          echo "  Added to ${PROFILE} (restart your shell or run: source ${PROFILE})"
        fi
      fi
      ;;
  esac
}

# ── Main ─────────────────────────────────────────────────

main() {
  echo ""
  echo "  🦑 Kraki Installer"
  echo ""

  detect_platform
  fetch_latest_version
  install

  echo ""
  echo "  ✓ Kraki ${VERSION} installed"
  echo ""

  # Auto-run interactive setup. KRAKI_INSTALL=1 tells kraki to show the
  # setup wizard + pairing QR but exit without starting the daemon.
  # The daemon is started below from the shell — on macOS 26+, kraki
  # cannot fork+exec itself (CSM provenance tracking), but the user's
  # shell can launch it just fine.
  KRAKI_INSTALL=1 "${INSTALL_DIR}/${BINARY_NAME}" </dev/tty

  # Start daemon in background from the shell
  mkdir -p "${HOME}/.kraki/logs"
  nohup "${INSTALL_DIR}/${BINARY_NAME}" __daemon-worker \
    </dev/null >"${HOME}/.kraki/logs/daemon-bootstrap.log" 2>&1 &
  DAEMON_PID=$!

  # Brief check that daemon survived startup
  sleep 1
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "  🦑 Kraki daemon started (PID $DAEMON_PID)"
  else
    echo "  ⚠  Daemon didn't start automatically. Run: kraki start"
  fi
  echo ""
}

main
