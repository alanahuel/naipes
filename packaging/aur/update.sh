#!/usr/bin/env bash
# Point packaging/aur/PKGBUILD at a published release (owner, 2026-11-06):
# sets pkgver, resets pkgrel to 1 and pins the sha256 of that release's
# .deb (downloaded from GitHub — the release must already be PUBLISHED, a
# draft's assets are not public). Then regenerates .SRCINFO next to it.
#
#   bash packaging/aur/update.sh 0.7.0
#
# Needs curl, sha256sum and makepkg (Arch, or the archlinux container in
# .github/workflows/aur.yml).
set -euo pipefail

version="${1:?usage: update.sh <version, e.g. 0.7.0>}"
version="${version#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a plain release version: $version" >&2; exit 1; }

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
url="https://github.com/alanahuel/naipes/releases/download/v${version}/Naipes-${version}-amd64.deb"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "==> Downloading $url"
curl -fsSL --retry 3 -o "$tmp/naipes.deb" "$url"
sum="$(sha256sum "$tmp/naipes.deb" | cut -d' ' -f1)"

sed -i \
	-e "s/^pkgver=.*/pkgver=${version}/" \
	-e "s/^pkgrel=.*/pkgrel=1/" \
	-e "s/^sha256sums=.*/sha256sums=('${sum}')/" \
	"$dir/PKGBUILD"
(cd "$dir" && makepkg --printsrcinfo > .SRCINFO)
echo "==> PKGBUILD → ${version} (sha256 ${sum})"
