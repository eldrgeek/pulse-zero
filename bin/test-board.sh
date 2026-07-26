#!/usr/bin/env bash
# test-board.sh — wrapper for the Pulse Zero board smoke test.
# Usage: PULSE_ZERO_SERVICE_KEY=... bin/test-board.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${PULSE_ZERO_SERVICE_KEY:-}" ]; then
  echo "PULSE_ZERO_SERVICE_KEY not set" >&2
  exit 1
fi

if ! curl -sS --max-time 2 http://localhost:9222/json/version >/dev/null 2>&1; then
  echo "Chrome debug endpoint (localhost:9222) not reachable — start debug Chrome first" >&2
  echo "  see ~/Projects/CLAUDE.md 'Only debug Chrome ever runs' / chrome-debug-launcher.sh" >&2
  exit 1
fi

exec python3 bin/test-board.py
