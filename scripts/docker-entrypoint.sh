#!/bin/sh
# Prepare a writable CODEX_HOME on tmpfs and copy host auth if mounted.
# Never fail startup when Codex is not configured.
set -eu

CODEX_HOME="${CODEX_HOME:-/tmp/codex-home}"
mkdir -p "$CODEX_HOME" 2>/dev/null || true

copy_if_present() {
  src="$1"
  dest="$2"
  if [ -f "$src" ]; then
    cp "$src" "$dest" 2>/dev/null || true
  fi
}

copy_if_present /codex-auth/auth.json "$CODEX_HOME/auth.json"
copy_if_present /codex-auth "$CODEX_HOME/auth.json"
copy_if_present /codex-auth/config.toml "$CODEX_HOME/config.toml"

exec "$@"
