#!/bin/bash
# Runs the comment/answer provenance migration against a throwaway local
# Postgres that replicates the live roles, auth.* functions, tables, policies
# and pre-migration webhook triggers, then asserts every forged-comment,
# forged-answer and legitimate-producer case in cases.sql.
#
#   test/pulse_answer_provenance/run.sh      exit 0 = all cases pass
#
# Needs Homebrew postgresql@16 (initdb, pg_ctl, psql). Touches no real project.
# Same harness as test/mac_commands_lockdown/run.sh (2026-09-19).
set -euo pipefail
export LC_ALL=C  # else macOS postmaster aborts: "became multithreaded during startup"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../../supabase/migrations/20260922_pulse_answer_provenance.sql"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
# /tmp, not $TMPDIR: the unix socket path must stay under 104 bytes on macOS.
DATA="$(mktemp -d /tmp/pap-pg.XXXXXX)"
PORT="${PORT:-55441}"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$DATA/log" -w start >/dev/null || { cat "$DATA/log" >&2; exit 1; }
PSQL=("$PGBIN/psql" -h "$DATA" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -f "$HERE/base.sql"
"${PSQL[@]}" -f "$MIGRATION"
# Applying twice must be a no-op (the migration is re-runnable).
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$HERE/cases.sql"
