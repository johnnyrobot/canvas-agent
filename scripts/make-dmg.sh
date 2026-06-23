#!/usr/bin/env bash
#
# Build the SHIPPABLE, notarized DMG from the already-signed + notarized .app.
#
# Why this exists: electron-builder's own `dmg` target corrupts the bundled
# framework signatures for this app — inside its dmg the Electron Framework reads
# "code object is not signed at all", so notarizing that dmg fails ("The signature
# of the binary is invalid"). Building the image ourselves with `ditto` + `hdiutil`
# copies the signed bundle faithfully (verified: the app inside the fresh dmg passes
# `codesign --verify --deep --strict`), so the dmg notarizes cleanly.
#
# Run AFTER electron-builder has produced + notarized + stapled the .app
# (i.e. after `electron-builder --mac`). Requires the notarytool keychain profile
# (APPLE_KEYCHAIN_PROFILE, default `canvas-agent-notary`) — same as `npm run package`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/release/mac-arm64/Canvas Agent.app"
VERSION="$(node -p "require('$ROOT/package.json').version")"
DMG="$ROOT/release/Canvas Agent-$VERSION-arm64.dmg"
IDENTITY="${CANVAS_SIGN_IDENTITY:-Developer ID Application: Quang Phung (7XU3QW326W)}"
PROFILE="${APPLE_KEYCHAIN_PROFILE:-canvas-agent-notary}"

[ -d "$APP" ] || { echo "error: $APP not found — run electron-builder --mac first"; exit 1; }

echo "==> [1/6] verify the source app is signed, hardened, and stapled"
codesign --verify --deep --strict "$APP"
xcrun stapler validate "$APP"

echo "==> [2/6] stage app + /Applications via ditto (faithful copy of signed bundle)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Canvas Agent.app"
ln -s /Applications "$STAGE/Applications"
codesign --verify --deep --strict "$STAGE/Canvas Agent.app"

echo "==> [3/6] create UDZO disk image"
rm -f "$DMG"
hdiutil create -volname "Canvas Agent $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

echo "==> [4/6] verify the app INSIDE the fresh dmg (catches a corrupt image before notarizing)"
MNT="$(hdiutil attach "$DMG" -nobrowse -readonly | grep -oE '/Volumes/[^"]*' | tail -1)"
if ! codesign --verify --deep --strict "$MNT/Canvas Agent.app"; then
  hdiutil detach "$MNT" >/dev/null || true
  echo "error: app inside the fresh dmg is not valid — aborting before notarization"; exit 1
fi
hdiutil detach "$MNT" >/dev/null

echo "==> [5/6] sign + notarize + staple the dmg"
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"

echo "==> [6/6] verify"
xcrun stapler validate "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"
echo "✓ notarized, stapled dmg: $DMG"
