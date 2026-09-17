#!/usr/bin/env python3
"""Differential fuzz: prove the DB card gate is a STRICT WEAKENING of the app tier.

The load-bearing invariant for
`supabase/migrations/UNAPPLIED-20260801_pulse_card_contract_gate.sql.draft`:

    if pulse_card_contract.validate_payload() ACCEPTS a payload,
    public.pulse_card_contract_violation() MUST also accept it.

The other direction is fine and expected — the CLI is allowed to be stricter.
But a DB rule stricter than the app tier silently kills a sanctioned producer
(`_estate/bin/pulse-drain`'s nightly escalator), which is the whole failure mode
the gate design exists to avoid.

This is not decoration. It has already caught two rules that looked obviously
safe and were not:

  * `options_shape` — 16 counterexamples. `{"options": 0}` passes
    validate_payload because `payload.get("options") or []` collapses 0 to [].
  * `field_type`    — 168 counterexamples. The app type-checks nothing but
    `action.title`.

RUN IT BEFORE ADDING ANY RULE TO THE DB TIER.

    python3 test/gen_card_gate_fuzz.py --out /tmp/fuzz
    psql "$SCRATCH_DB" -f /tmp/fuzz/fuzz_0.sql [... -f fuzz_N.sql] -f fuzz_query.sql

`app_ok_db_bad` in the summary must be 0. Chunked output is deliberate: a single
file trips the >256KB limit on piping SQL into psql.
"""

import argparse
import itertools
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))
from pulse_card_contract import (  # noqa: E402
    ESCALATION_TITLE_MAX, TITLE_MAX, CardContractError, validate_payload,
)

# Values chosen to straddle every boundary either tier knows about: absence,
# blankness, the 60-char board standard, pulse-drain's 96-char construction
# ceiling, the 160-char sanctioned override, the 240-char DB runaway fence, and
# every JSON type that is neither string nor null.
VALUES = [None, "", "   ", "ok",
          "x" * 61, "x" * 96, "x" * 161, "x" * 241,
          0, [], ["A"], {"k": 1}]

TYPES = [
    ("action",   ["title", "steps", "url"]),
    ("decision", ["question", "options", "why"]),
    ("verdict",  ["artifact_name", "url", "summary"]),
    ("brief",    ["title", "lines"]),
]

# title_max 60 = pulse-push / pulse-morning. 160 = pulse-drain's escalator.
TITLE_MAXES = (TITLE_MAX, ESCALATION_TITLE_MAX)


def cases():
    for card_type, fields in TYPES:
        for combo in itertools.product(VALUES, repeat=2):
            payload = {f: combo[i] for i, f in enumerate(fields[:2])}
            for f in fields[2:]:
                payload[f] = "filler"
            for tm in TITLE_MAXES:
                yield card_type, dict(payload), tm
    # Hand-picked shapes the product above cannot reach.
    yield "action", {}, TITLE_MAX
    yield "action", None, TITLE_MAX
    yield "reminder", {"title": "x"}, TITLE_MAX
    yield "decision", {"question": "q", "options": "A,B"}, TITLE_MAX
    yield "verdict", {"artifact": "a", "url": "u", "summary": "s"}, TITLE_MAX


def app_verdict(card_type, payload, title_max):
    try:
        validate_payload(card_type, payload, title_max=title_max)
        return "accept", ""
    except CardContractError as e:
        return "reject", e.rule
    except Exception as e:
        # Not a clean contract failure. Worth reporting on its own: pulse-drain
        # catches (CardContractError, SystemExit), so a raw AttributeError from
        # validate_payload kills the nightly loop instead of skipping one card.
        return "reject", "crash:" + type(e).__name__


def literal(card_type, payload, title_max, app, rule):
    pj = "null" if payload is None else "$pz$" + json.dumps(payload) + "$pz$::jsonb"
    tt = "null" if card_type is None else "$pz$" + card_type + "$pz$"
    return f"({tt},{pj},{title_max},$pz${app}$pz$,$pz${rule}$pz$)"


QUERY = r"""
\echo '--- DANGEROUS DIRECTION: app ACCEPTS but DB REJECTS (must be 0 rows) ---'
select n, type, title_max, app_rule,
       left(public.pulse_card_contract_violation(type, payload), 90) as db
  from public.fuzz_cases
 where app = 'accept'
   and public.pulse_card_contract_violation(type, payload) is not null;

\echo '--- summary (app_ok_db_bad MUST be 0) ---'
select count(*) as cases,
  count(*) filter (where app = 'accept') as app_accepts,
  count(*) filter (where public.pulse_card_contract_violation(type, payload) is null) as db_accepts,
  count(*) filter (where app = 'accept'
                     and public.pulse_card_contract_violation(type, payload) is not null) as app_ok_db_bad,
  count(*) filter (where app = 'reject'
                     and public.pulse_card_contract_violation(type, payload) is null) as app_bad_db_ok
  from public.fuzz_cases;

\echo '--- rules the DB deliberately leaves to the CLI ---'
select app_rule, count(*) from public.fuzz_cases
 where app = 'reject'
   and public.pulse_card_contract_violation(type, payload) is null
 group by 1 order by 2 desc;
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="directory for the generated .sql chunks")
    ap.add_argument("--chunk", type=int, default=250, help="cases per file (keeps each under 256KB)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    rows = [(t, p, tm) + app_verdict(t, p, tm) for t, p, tm in cases()]

    header = (
        "create table if not exists public.fuzz_cases"
        " (n serial, type text, payload jsonb, title_max int, app text, app_rule text);\n"
        "delete from public.fuzz_cases where n > 0;\n"
    )
    files = []
    for i in range(0, len(rows), a.chunk):
        chunk = rows[i:i + a.chunk]
        body = ("insert into public.fuzz_cases(type,payload,title_max,app,app_rule) values\n"
                + ",\n".join(literal(*r) for r in chunk) + ";\n")
        path = os.path.join(a.out, f"fuzz_{i // a.chunk}.sql")
        with open(path, "w") as f:
            f.write((header if i == 0 else "") + body)
        files.append(path)
    qpath = os.path.join(a.out, "fuzz_query.sql")
    with open(qpath, "w") as f:
        f.write(QUERY)
    files.append(qpath)

    crashes = sum(1 for r in rows if r[4].startswith("crash:"))
    print(f"{len(rows)} cases -> {len(files)} files in {a.out}")
    if crashes:
        print(f"note: {crashes} cases made validate_payload raise a NON-CardContractError "
              f"exception. pulse-drain catches (CardContractError, SystemExit) only, so "
              f"those would kill the nightly loop rather than skip one card.")
    print("run:  psql \"$SCRATCH_DB\" " + " ".join(f"-f {p}" for p in files))


if __name__ == "__main__":
    main()
