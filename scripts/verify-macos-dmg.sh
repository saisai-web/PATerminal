#!/usr/bin/env bash

set -euo pipefail

EXPECTED_IDENTIFIER="com.paralellterminal.app"
EXPECTED_MINIMUM_SYSTEM_VERSION="11.0"
EXPECTED_TEAM_ID=""
DMG_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/verify-macos-dmg.sh --team-id TEAM_ID [options] DMG_PATH

Verify a PATerminal release DMG before it is published.

Options:
  --team-id TEAM_ID                 Expected Apple Developer Team ID (required)
  --identifier BUNDLE_ID            Expected bundle identifier
                                    (default: com.paralellterminal.app)
  --minimum-system-version VERSION  Expected LSMinimumSystemVersion
                                    (default: 11.0)
  -h, --help                        Show this help
EOF
}

fail() {
  printf 'macOS DMG verification failed: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team-id)
      [[ $# -ge 2 ]] || fail "--team-id requires a value"
      EXPECTED_TEAM_ID="$2"
      shift 2
      ;;
    --identifier)
      [[ $# -ge 2 ]] || fail "--identifier requires a value"
      EXPECTED_IDENTIFIER="$2"
      shift 2
      ;;
    --minimum-system-version)
      [[ $# -ge 2 ]] || fail "--minimum-system-version requires a value"
      EXPECTED_MINIMUM_SYSTEM_VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      fail "unknown option: $1"
      ;;
    *)
      [[ -z "$DMG_PATH" ]] || fail "only one DMG path may be supplied"
      DMG_PATH="$1"
      shift
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail "this script must run on macOS"
[[ -n "$EXPECTED_TEAM_ID" ]] || fail "--team-id is required"
[[ -n "$DMG_PATH" ]] || fail "DMG_PATH is required"
[[ -f "$DMG_PATH" ]] || fail "DMG not found: $DMG_PATH"

for command_name in codesign hdiutil lipo plutil spctl xcrun; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
done

MOUNT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paterminal-dmg.XXXXXX")"
DMG_ATTACHED=0

cleanup() {
  if [[ "$DMG_ATTACHED" -eq 1 ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  fi
  rmdir "$MOUNT_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

printf 'Verifying DMG integrity...\n'
hdiutil verify "$DMG_PATH" >/dev/null

printf 'Verifying DMG notarization and stapled ticket...\n'
if ! DMG_GATEKEEPER_OUTPUT="$(spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH" 2>&1)"; then
  printf '%s\n' "$DMG_GATEKEEPER_OUTPUT" >&2
  fail "Gatekeeper rejected the DMG"
fi
grep -q 'accepted' <<<"$DMG_GATEKEEPER_OUTPUT" || fail "DMG Gatekeeper result did not contain accepted"
grep -q 'source=Notarized Developer ID' <<<"$DMG_GATEKEEPER_OUTPUT" || fail "DMG was not accepted as a notarized Developer ID artifact"
xcrun stapler validate "$DMG_PATH"

printf 'Mounting DMG read-only...\n'
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG_PATH" >/dev/null
DMG_ATTACHED=1

APP_PATH="$MOUNT_DIR/PATerminal.app"
[[ -d "$APP_PATH" ]] || fail "PATerminal.app was not found at the DMG root"

INFO_PLIST="$APP_PATH/Contents/Info.plist"
[[ -f "$INFO_PLIST" ]] || fail "Info.plist was not found in PATerminal.app"

BUNDLE_IDENTIFIER="$(plutil -extract CFBundleIdentifier raw -o - "$INFO_PLIST")"
[[ "$BUNDLE_IDENTIFIER" == "$EXPECTED_IDENTIFIER" ]] || \
  fail "bundle identifier is $BUNDLE_IDENTIFIER; expected $EXPECTED_IDENTIFIER"

MINIMUM_SYSTEM_VERSION="$(plutil -extract LSMinimumSystemVersion raw -o - "$INFO_PLIST")"
[[ "$MINIMUM_SYSTEM_VERSION" == "$EXPECTED_MINIMUM_SYSTEM_VERSION" ]] || \
  fail "LSMinimumSystemVersion is $MINIMUM_SYSTEM_VERSION; expected $EXPECTED_MINIMUM_SYSTEM_VERSION"

printf 'Verifying Developer ID signature and hardened runtime...\n'
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
SIGNATURE_INFO="$(codesign --display --verbose=4 "$APP_PATH" 2>&1)"

grep -q "^Identifier=${EXPECTED_IDENTIFIER}$" <<<"$SIGNATURE_INFO" || \
  fail "codesign identifier does not match $EXPECTED_IDENTIFIER"
grep -q '^Authority=Developer ID Application:' <<<"$SIGNATURE_INFO" || \
  fail "Developer ID Application authority was not found"
grep -q "^TeamIdentifier=${EXPECTED_TEAM_ID}$" <<<"$SIGNATURE_INFO" || \
  fail "TeamIdentifier does not match the expected Team ID"
grep -Eq '^CodeDirectory .*flags=.*\(.*runtime.*\)' <<<"$SIGNATURE_INFO" || \
  fail "hardened runtime flag was not found"

printf 'Verifying app notarization and stapled ticket...\n'
if ! APP_GATEKEEPER_OUTPUT="$(spctl --assess --type execute --verbose=4 "$APP_PATH" 2>&1)"; then
  printf '%s\n' "$APP_GATEKEEPER_OUTPUT" >&2
  fail "Gatekeeper rejected PATerminal.app"
fi
grep -q 'accepted' <<<"$APP_GATEKEEPER_OUTPUT" || fail "app Gatekeeper result did not contain accepted"
grep -q 'source=Notarized Developer ID' <<<"$APP_GATEKEEPER_OUTPUT" || \
  fail "app was not accepted as a notarized Developer ID application"
xcrun stapler validate "$APP_PATH"

EXECUTABLE_NAME="$(plutil -extract CFBundleExecutable raw -o - "$INFO_PLIST")"
EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/$EXECUTABLE_NAME"
[[ -f "$EXECUTABLE_PATH" ]] || fail "main executable was not found: $EXECUTABLE_PATH"

ARCHITECTURES="$(lipo -archs "$EXECUTABLE_PATH")"
NORMALIZED_ARCHITECTURES="$({ for architecture in $ARCHITECTURES; do printf '%s\n' "$architecture"; done; } | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$NORMALIZED_ARCHITECTURES" == "arm64 x86_64" ]] || \
  fail "main executable architectures are '$ARCHITECTURES'; expected exactly arm64 and x86_64"

printf 'macOS DMG verification passed: identifier=%s, minimum-system-version=%s, architectures=%s\n' \
  "$EXPECTED_IDENTIFIER" "$EXPECTED_MINIMUM_SYSTEM_VERSION" "$ARCHITECTURES"
