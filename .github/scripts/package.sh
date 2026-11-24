#!/usr/bin/env bash
#
# package.sh IN OUT: the release names, from the build artifacts in IN.
#
#   charsiu-desktop_<version>_arm64-setup.exe   Windows arm64 (NSIS)
#   charsiu-desktop_<version>_arm64.deb         Linux arm64
#   charsiu-desktop_<version>_aarch64.AppImage  Linux arm64, when it built
#
# Tauri names the installer after the product, "Charsiu Desktop_...", and a
# space in an asset name comes back from GitHub as a dot, so the names in
# SHA256SUMS.txt stopped matching the files people downloaded. These names
# have no spaces and are the same on the release as in the checksums.
#
# SPDX-License-Identifier: GPL-2.0-only
set -euo pipefail
in=$1 out=$2
ver=$(jq -r .version package.json)
[ "$ver" = "$(jq -r .version src-tauri/tauri.conf.json)" ] || { echo "package.json and tauri.conf.json disagree on the version" >&2; exit 1; }
mkdir -p "$out"
one() {  # one PATTERN NAME [optional]
    mapfile -t f < <(find "$in" -type f -name "$1")
    if [ "${#f[@]}" -eq 0 ]; then
        [ "${3:-}" = optional ] && { echo "no $1 (optional)"; return 0; }
        echo "no $1 in $in" >&2; exit 1
    fi
    [ "${#f[@]}" -eq 1 ] || { echo "more than one $1: ${f[*]}" >&2; exit 1; }
    cp "${f[0]}" "$out/$2"
    echo "$2 <- ${f[0]#$in/}"
}
one '*-setup.exe' "charsiu-desktop_${ver}_arm64-setup.exe"
one '*.deb' "charsiu-desktop_${ver}_arm64.deb"
one '*.AppImage' "charsiu-desktop_${ver}_aarch64.AppImage" optional
(cd "$out" && sha256sum -- * > SHA256SUMS.txt && cat SHA256SUMS.txt)
echo "version=$ver" >> "${GITHUB_OUTPUT:-/dev/null}"
