#!/bin/bash
# Runs the panel/focus experiments (questions 1 and 2). Needs TextEdit + System Events automation consent.
cd "$(dirname "$0")/../.." || exit 1
export PATH=~/.nvm/versions/node/v22.22.2/bin:$PATH
BIN="${TMPDIR:-/tmp}/quick-ask-spike-bin"; mkdir -p "$BIN"
[ -x "$BIN/windows" ] || swiftc -O spike/quick-ask/windows.swift -o "$BIN/windows"
export WINDOWS_TOOL="$BIN/windows"
run() {
  echo "=== $*"
  env "$@" npx electron spike/quick-ask/main.js focus 2>&1 | grep SPIKE | sed 's/\x1b\[[0-9;]*m//g'
}
run SHOW=show HIDE=0
run SHOW=show HIDE=1
run SHOW=showInactive HIDE=0
run SHOW=show HIDE=0 FS=1
run SHOW=show HIDE=1 FS=1
