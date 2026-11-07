#!/usr/bin/env bash
# Inspect the actual linked runtime, not Info.plist or the packaging machine's SDK.
set -euo pipefail

build=$(xcrun vtool -show-build "${1:?usage: check-ios-sdk.sh <iOS executable>}")
printf '%s\n' "$build"
printf '%s\n' "$build" | awk '
  $1 == "platform" { platform = $2 }
  $1 == "sdk" {
    count++
    if (platform != "IOS" || $2 + 0 < 27) invalid = 1
  }
  END {
    if (!count || invalid) {
      print "Expected an iOS device binary linked with SDK 27 or newer; rebuild the native runtime." > "/dev/stderr"
      exit 1
    }
  }
'
