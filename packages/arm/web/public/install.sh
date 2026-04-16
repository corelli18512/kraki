#!/bin/sh
# Kraki installer — https://kraki.corelli.cloud
# Usage: curl -fsSL https://kraki.corelli.cloud/install.sh | bash
set -e

REPO="corelli18512/kraki"
INSTALL_DIR="/usr/local/bin"
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
  TARGET="${TMP}/${BINARY_NAME}"

  echo "  Installing Kraki ${VERSION} (${PLATFORM}/${ARCH})..."

  if ! curl -fSL# -o "$TARGET" "$URL"; then
    echo "Error: Download failed — ${URL}"
    rm -rf "$TMP"
    exit 1
  fi

  chmod +x "$TARGET"

  # macOS: remove quarantine/provenance xattrs so Gatekeeper doesn't
  # SIGKILL the daemon child process even when the binary is signed.
  if [ "$PLATFORM" = "macos" ]; then
    xattr -cr "$TARGET" 2>/dev/null || true
  fi

  # Windows (Git Bash): install to user's local bin
  if [ "$PLATFORM" = "windows" ]; then
    INSTALL_DIR="${HOME}/bin"
    mkdir -p "$INSTALL_DIR"
    mv "$TARGET" "${INSTALL_DIR}/${BINARY_NAME}"
    echo "  Installed to ${INSTALL_DIR}/${BINARY_NAME}"
    rm -rf "$TMP"
    return
  fi

  # macOS / Linux: try /usr/local/bin, fall back to ~/.local/bin
  if [ -w "$INSTALL_DIR" ]; then
    mv "$TARGET" "${INSTALL_DIR}/${BINARY_NAME}"
    echo "  Installed to ${INSTALL_DIR}/${BINARY_NAME}"
  elif command -v sudo >/dev/null 2>&1; then
    echo "  Installing to ${INSTALL_DIR} (requires sudo)..."
    sudo mv "$TARGET" "${INSTALL_DIR}/${BINARY_NAME}"
    echo "  Installed to ${INSTALL_DIR}/${BINARY_NAME}"
  else
    INSTALL_DIR="${HOME}/.local/bin"
    mkdir -p "$INSTALL_DIR"
    mv "$TARGET" "${INSTALL_DIR}/${BINARY_NAME}"
    echo "  Installed to ${INSTALL_DIR}/${BINARY_NAME}"
    case ":$PATH:" in
      *":${INSTALL_DIR}:"*) ;;
      *) echo "  ⚠  Add to PATH:  export PATH=\"\$PATH:${INSTALL_DIR}\"" ;;
    esac
  fi

  rm -rf "$TMP"
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
