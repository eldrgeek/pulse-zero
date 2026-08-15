#!/usr/bin/env bash
# gen-findings-demo-steps.sh — write a fresh _estate/bin/demo-record steps.json
# for narrating public/review/. Regenerates a one-time-use Supabase magic-link
# token each run (mints via the admin API, spends on first verifyOtp call in
# the recording) — never commit the OUTPUT of this script, only this
# generator. See README.md "Report cards: evidence, inspect, drill, attended".
#
# USAGE
#   review/demo-steps/gen-findings-demo-steps.sh /path/to/steps.json
#   _estate/bin/demo-record https://pulse-zero.netlify.app/review/ <slug> \
#     --steps /path/to/steps.json --viewport 1280x800 --tts
set -euo pipefail

OUT="${1:?usage: gen-findings-demo-steps.sh <output-steps.json>}"

export PULSE_ZERO_SUPABASE_URL="https://omfwcodoimjmbrhssvfl.supabase.co"
set -a
# shellcheck disable=SC1090
. ~/Projects/pulse-mac-bridge/.env
set +a
export PULSE_ZERO_SERVICE_KEY="$PULSE_MAC_SERVICE_KEY"

GEN=$(curl -s -X POST "$PULSE_ZERO_SUPABASE_URL/auth/v1/admin/generate_link" \
  -H "apikey: $PULSE_ZERO_SERVICE_KEY" -H "Authorization: Bearer $PULSE_ZERO_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"magiclink","email":"mw@mike-wolf.com","options":{"redirect_to":"https://pulse-zero.netlify.app/review/"}}')

TOKEN=$(echo "$GEN" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('hashed_token') or d.get('properties',{}).get('hashed_token'))")
if [ -z "$TOKEN" ] || [ "$TOKEN" = "None" ]; then
  echo "failed to generate magic-link token" >&2
  echo "$GEN" >&2
  exit 1
fi

python3 - "$TOKEN" <<'PYEOF' > "$OUT"
import json, sys
token = sys.argv[1]
steps = [
  {
    # Same admin-generated-magic-link technique bin/test-board.py uses for
    # CDP login: mint a token server-side, verify it in-page against the
    # global `sb` client public/review/index.html already exposes.
    "action": "eval",
    "ms": 900,
    "code": (
      "const { data, error } = await sb.auth.verifyOtp({ token_hash: " + json.dumps(token) + ", type: 'magiclink' }); "
      "return { ok: !!(data && data.session), error: error && error.message };"
    ),
  },
  {"action": "wait", "ms": 1200,
   "narrate": "Card 7b3ed1e4 used to say 43 findings fixed, with no way to look at them. This is the fix: sign in, and every finding is right here."},
  {"action": "click", "selector": ".finding-head",
   "narrate": "Each finding expands to its FIXED or WONT-FIX status, the exact mechanism, and a commit reference."},
  {"action": "wait", "ms": 1800},
  {"action": "click", "selector": ".chip[data-value=\"CODE\"]",
   "narrate": "Filter by lane, severity, or status to jump straight to what you're asking about."},
  {"action": "wait", "ms": 1600},
  {"action": "click", "selector": ".finding-head",
   "narrate": "And if you have a question the card's own comment thread answers it in about a minute — a teammate reads this exact page first."},
  {"action": "wait", "ms": 1800},
]
json.dump(steps, sys.stdout, indent=2)
PYEOF
echo "wrote $OUT" >&2
