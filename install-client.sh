#!/usr/bin/env bash
# Installs the Noop client app, or updates it (Linux / macOS):
#   curl -fsSL https://huacnlee.github.io/noop/install-client.sh | bash
# NOOP_CLIENT_BASE_URL  where the release assets are (default: the latest GitHub release)
set -euo pipefail

BASE="${NOOP_CLIENT_BASE_URL:-https://github.com/huacnlee/noop/releases/latest/download}"

fail() { printf "Noop: %s\n" "$*" >&2; exit 1; }
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

case "$(uname -s)" in
  Darwin)
    # A shell under Rosetta reports x86_64 on an Apple silicon Mac, so ask the hardware.
    [ "$(sysctl -n hw.optional.arm64 2> /dev/null || true)" = 1 ] || fail "the macOS client needs Apple silicon"
    [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ] || fail "the macOS client needs macOS 14 or later"
    ASSET=Noop-macos-arm64.zip ;;
  Linux)
    [ "$(uname -m)" = x86_64 ] || fail "the Linux client needs x86_64"
    ASSET=Noop-linux-x86_64.tar.gz ;;
  *) fail "use install-client.ps1 on Windows" ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "Downloading $ASSET"
curl -fsSL "$BASE/$ASSET" -o "$WORK/$ASSET"
curl -fsSL "$BASE/SHA256SUMS" -o "$WORK/SHA256SUMS"
EXPECTED="$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1 }' "$WORK/SHA256SUMS")"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$(sha256 "$WORK/$ASSET")" ] || fail "the checksum of $ASSET does not match"

if [ "$(uname -s)" = Darwin ]; then
  ditto -x -k "$WORK/$ASSET" "$WORK/unpacked"
  [ -d "$WORK/unpacked/Noop.app" ] || fail "$ASSET holds no Noop.app"
  APPS=/Applications
  if [ ! -w "$APPS" ]; then APPS="$HOME/Applications"; mkdir -p "$APPS"; fi
  rm -rf "$APPS/Noop.app"
  mv "$WORK/unpacked/Noop.app" "$APPS/Noop.app"
  printf "Installed %s/Noop.app\n\nOpen it from Launchpad or Spotlight. If it is running, quit it to use the new version.\n" "$APPS"
else
  tar -xzf "$WORK/$ASSET" -C "$WORK"
  [ -x "$WORK/Noop/Noop" ] || fail "$ASSET holds no Noop/Noop"
  DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
  DIR="$DATA/noop-client"
  rm -rf "$DIR"
  mkdir -p "$DATA" "$DATA/applications" "$DATA/icons/hicolor/512x512/apps" "$HOME/.local/bin"
  mv "$WORK/Noop" "$DIR"
  ln -sf "$DIR/Noop" "$HOME/.local/bin/noop-client"
  cp "$DIR/dev.noop.app.png" "$DATA/icons/hicolor/512x512/apps/dev.noop.app.png"
  sed "s|^Exec=.*|Exec=$DIR/Noop|" "$DIR/dev.noop.app.desktop" > "$DATA/applications/dev.noop.app.desktop"
  command -v update-desktop-database > /dev/null && update-desktop-database "$DATA/applications" > /dev/null 2>&1 || true
  printf "Installed %s\n\nOpen Noop from your launcher, or run noop-client.\n" "$DIR"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to use the noop-client command." ;; esac
  MISSING="$(ldd "$DIR/Noop" 2> /dev/null | grep 'not found' || true)"
  if [ -n "$MISSING" ]; then
    printf "\nThe app needs GTK 4.14 or later and glibc 2.39 or later (Ubuntu 24.04 or newer). Missing:\n%s\n" "$MISSING"
    echo "On Debian or Ubuntu: sudo apt install libgtk-4-1"
  fi
  # Videos play through GStreamer: MP4 needs qtdemux (plugins-good), H.264 needs
  # libav, and hub URLs need souphttpsrc. Without them the player shows an error.
  if command -v pacman > /dev/null; then
    GST="$(for p in gst-plugins-good gst-libav; do pacman -Q "$p" > /dev/null 2>&1 || echo "$p"; done)"
    [ -z "$GST" ] || { echo "Installing GStreamer plug-ins for video playback: $GST"; sudo pacman -S --needed --noconfirm $GST || echo "Install them to play videos: sudo pacman -S $GST"; }
  elif command -v apt-get > /dev/null; then
    GST="$(for p in gstreamer1.0-plugins-good gstreamer1.0-libav; do dpkg -s "$p" > /dev/null 2>&1 || echo "$p"; done)"
    [ -z "$GST" ] || { echo "Installing GStreamer plug-ins for video playback: $GST"; sudo apt-get install -y $GST || echo "Install them to play videos: sudo apt install $GST"; }
  fi
fi
