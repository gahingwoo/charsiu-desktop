#!/bin/sh
# Build ui/vendor/patternfly.css from the PatternFly 6 npm package: the base
# (reset, globals, fonts, tokens) and only the components this app uses.
#
#   sh tools/patternfly/build.sh
#
# The package is fetched from the npm registry and checked against the
# sha256 below, so a rebuild gives the same file. To upgrade, change VERSION
# and SHA256 together (sha256sum of the .tgz) and run this again.
#
# SPDX-License-Identifier: GPL-2.0-only
set -eu

VERSION=6.7.0
SHA256=d5060da11518202395a4f162cab91f04baf88826d6e04766f22923fdec070f86

# Components in the order they are concatenated. A class with no CSS behind
# it renders as plain HTML, so a new component goes here first.
COMPONENTS="Alert Backdrop Button Card CodeBlock Content DescriptionList
Divider EmptyState Form FormControl HelperText ModalBox Progress Spinner
Table Title"
LAYOUTS="Bullseye"

HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(cd "$HERE/../.." && pwd)
OUT=$TOP/ui/vendor
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

TGZ=$TMP/patternfly-$VERSION.tgz
curl -fsSL -o "$TGZ" "https://registry.npmjs.org/@patternfly/patternfly/-/patternfly-$VERSION.tgz"
echo "$SHA256  $TGZ" | sha256sum -c - >/dev/null
tar -C "$TMP" -xzf "$TGZ"
P=$TMP/package

mkdir -p "$OUT/fonts"
CSS=$OUT/patternfly.css
{
	printf '/* PatternFly %s (MIT), built by tools/patternfly/build.sh. Do not edit. */\n' "$VERSION"
	# patternfly-base.css is reset + common + font faces, then the icon
	# fonts, then the tokens. The icon fonts are not used here (icons are
	# inline SVG), so take everything before the first icon rule ...
	awk '/^\.fa-lg \{/ { exit } { print }' "$P/patternfly-base.css" \
		| sed 's#\./assets/fonts/[A-Za-z]*/#./fonts/#g'
	# ... and the tokens on their own. The glass background images belong
	# to a theme this app does not use.
	sed 's#url("\.\./assets/images/[^"]*")#none#g' "$P/base/patternfly-variables.css"
	for c in $COMPONENTS; do
		for f in "$P/components/$c"/*.css; do
			printf '\n/* %s */\n' "${f#"$P"/}"
			cat "$f"
		done
	done
	for l in $LAYOUTS; do
		for f in "$P/layouts/$l"/*.css; do
			printf '\n/* %s */\n' "${f#"$P"/}"
			cat "$f"
		done
	done
} > "$CSS"

grep -q 'Red Hat Text' "$CSS" || { echo "build.sh: no font faces in the base" >&2; exit 1; }
grep -q 'pf-v6-c-modal-box' "$CSS" || { echo "build.sh: components missing" >&2; exit 1; }
if grep -n 'url("\./assets' "$CSS"; then echo "build.sh: an asset URL was not rewritten" >&2; exit 1; fi

for f in RedHatText/RedHatTextVF.woff2 RedHatText/RedHatTextVF-Italic.woff2 \
	 RedHatDisplay/RedHatDisplayVF.woff2 RedHatDisplay/RedHatDisplayVF-Italic.woff2 \
	 RedHatMono/RedHatMonoVF.woff2 RedHatMono/RedHatMonoVF-Italic.woff2; do
	cp "$P/assets/fonts/$f" "$OUT/fonts/"
done
cp "$P/LICENSE.txt" "$OUT/LICENSE.patternfly.txt" 2>/dev/null \
	|| printf 'PatternFly %s is MIT licensed: https://github.com/patternfly/patternfly\n' "$VERSION" > "$OUT/LICENSE.patternfly.txt"
echo "$VERSION" > "$OUT/VERSION"
echo "build.sh: $CSS ($(wc -c < "$CSS") bytes), PatternFly $VERSION"
