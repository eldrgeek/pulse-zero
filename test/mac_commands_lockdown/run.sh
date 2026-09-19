#!/bin/bash
# Runs the mac_commands lockdown migration against a throwaway local Postgres
# that replicates the live roles, auth.* functions, tables and policy, then
# asserts every forged-row and legitimate-producer case in cases.sql.
#
#   test/mac_commands_lockdown/run.sh        exit 0 = all cases pass
#
# Needs Homebrew postgresql@16 (initdb, pg_ctl, psql). Touches no real project.
set -euo pipefail
export LC_ALL=C  # else macOS postmaster aborts: "became multithreaded during startup"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../../supabase/migrations/20260919_mac_commands_lockdown.sql"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
# /tmp, not $TMPDIR: the unix socket path must stay under 104 bytes on macOS.
DATA="$(mktemp -d /tmp/mlk-pg.XXXXXX)"
PORT="${PORT:-55439}"
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
