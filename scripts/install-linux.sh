#!/usr/bin/env bash
# Build LearnHarness from THIS checkout as a local AppImage and install it as
# a desktop application for the current user (owner, 2026-11-01).
#
#   bash scripts/install-linux.sh            # build + install
#   bash scripts/install-linux.sh --no-build # reinstall the last dist/ AppImage
#
# The package is marked `lhLocalBuild: true` (electron-builder extraMetadata),
# which turns the GitHub auto-updater OFF: a local build carries the owner's
# own changes and must never be replaced by an upstream release. To update,
# pull/commit your changes and run this script again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

INSTALL_DIR="${LH_INSTALL_DIR:-$HOME/.local/opt/LearnHarness}"
APPIMAGE="$INSTALL_DIR/LearnHarness.AppImage"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
DESKTOP_FILE="$HOME/.local/share/applications/learnharness.desktop"

if [[ "${1:-}" != "--no-build" ]]; then
	echo "==> Compilando Next (standalone)"
	rm -rf dist .next/standalone
	npm run build
	echo "==> Preparando el servidor empaquetado"
	node scripts/build-server.mjs
	echo "==> Prueba de arranque del servidor"
	node scripts/smoke-server.mjs --electron
	echo "==> Empaquetando AppImage (sin auto-update)"
	npx electron-builder --linux AppImage --x64 --publish never -c.extraMetadata.lhLocalBuild=true
fi

BUILT="$(ls -t dist/LearnHarness-*.AppImage 2>/dev/null | head -1 || true)"
if [[ -z "$BUILT" ]]; then
	echo "No se encontró ningún AppImage en dist/." >&2
	exit 1
fi

echo "==> Instalando $BUILT"
mkdir -p "$INSTALL_DIR" "$ICON_DIR" "$(dirname "$DESKTOP_FILE")"
install -m 0755 "$BUILT" "$APPIMAGE.new"
mv -f "$APPIMAGE.new" "$APPIMAGE"
install -m 0644 build/icon.png "$ICON_DIR/learnharness.png"

cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=LearnHarness
Comment=Tutor de aprendizaje y grafo de conocimiento
Exec="$APPIMAGE" %U
Icon=learnharness
Terminal=false
Categories=Education;
StartupWMClass=learnharness
EOF

update-desktop-database "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo "==> Listo: $APPIMAGE"
echo "    Lanzador: $DESKTOP_FILE"
