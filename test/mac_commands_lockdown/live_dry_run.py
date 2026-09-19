#!/usr/bin/env python3
"""Emit ONE SQL statement that applies 20260919_mac_commands_lockdown.sql and
runs forged-row cases as each real role, then raises on purpose so nothing
commits. Used to test the migration against the live project's real schema,
functions and cards before applying it.

    live_dry_run.py > dry.sql      # then send dry.sql as a single query

The statement always ends in an error whose message starts DRYRUN_RESULTS:
followed by JSON. Any other error means the migration itself failed.
A single DO block is atomic, so the raise rolls back the migration too.
"""
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
MIGRATION = (HERE / "../../supabase/migrations/20260919_mac_commands_lockdown.sql").read_text()
assert "$mig$" not in MIGRATION

CASES = [
    # (name, role, claims, sql, should_succeed)
    ("service: verify_command shell row refused", "service_role", '{"role":"service_role"}',
     """insert into public.mac_commands(command, payload) values ('clipboard_take_and_deploy',
        '{"destination":{"type":"group_bc_credential","credential":"gemini"},"verify_command":"touch /tmp/pwned"}')""", False),
    ("service: open_session refused even stamped as a click", "service_role", '{"role":"service_role"}',
     """insert into public.mac_commands(command, payload) values ('open_session',
        '{"message":"x","interaction":"user_click"}')""", False),
    ("service: execute_card_action refused", "service_role", '{"role":"service_role"}',
     """insert into public.mac_commands(command, payload) values ('execute_card_action', '{"contract_version":1}')""", False),
    ("service: clipboard_set refused", "service_role", '{"role":"service_role"}',
     """insert into public.mac_commands(command, payload) values ('clipboard_set', '{"text":"x"}')""", False),
    ("service: speak still accepted and stamped", "service_role", '{"role":"service_role"}',
     """do $d$ declare r record; begin
          insert into public.mac_commands(command, payload, enqueued_role, enqueued_email)
          values ('speak', '{"text":"dry run"}', 'authenticated', 'mw@mike-wolf.com')
          returning enqueued_role, enqueued_email into r;
          if r.enqueued_role <> 'service_role' or r.enqueued_email is not null then
            raise exception 'not stamped: %', row_to_json(r); end if; end $d$""", True),
    ("service: act_on_answer still accepted", "service_role", '{"role":"service_role"}',
     """insert into public.mac_commands(command, payload) values ('act_on_answer', '{"card_id":"x","status":"answered"}')""", True),
    ("service: cannot rewrite a historical row's payload", "service_role", '{"role":"service_role"}',
     """update public.mac_commands set payload = payload || '{"dry_run_tamper": true}' where id = (select min(id) from public.mac_commands)""", False),
    ("service: can still record status", "service_role", '{"role":"service_role"}',
     """update public.mac_commands set result = result where id = (select min(id) from public.mac_commands)""", True),
    ("anon: refused", "anon", '{"role":"anon"}',
     """insert into public.mac_commands(command, payload) values ('speak', '{"text":"x"}')""", False),
    ("non-owner user: refused", "authenticated", '{"role":"authenticated","email":"someone@example.com"}',
     """insert into public.mac_commands(command, payload) values ('speak', '{"text":"x"}')""", False),
    ("Mike: open_session not on any open card refused", "authenticated", '{"role":"authenticated","email":"mw@mike-wolf.com"}',
     """insert into public.mac_commands(command, payload, pulse_card_id)
        select 'open_session', '{"message":"forged","interaction":"user_click"}', id
        from public.pulse_cards where status = 'open' limit 1""", False),
    ("Mike: can still read receipts", "authenticated", '{"role":"authenticated","email":"mw@mike-wolf.com"}',
     """do $d$ begin if (select count(*) from public.mac_commands) = 0 then raise exception 'none visible'; end if; end $d$""", True),
    ("Mike: can no longer update rows", "authenticated", '{"role":"authenticated","email":"mw@mike-wolf.com"}',
     """update public.mac_commands set status = status where false""", False),
]


def q(text):
    return "$c$" + text + "$c$"


lines = [
    "do $outer$",
    "declare v_err text; v_results jsonb := '[]'::jsonb;",
    "begin",
    "  execute $mig$" + MIGRATION + "$mig$;",
]
for name, role, claims, sql, ok in CASES:
    lines += [
        "  begin",
        f"    perform set_config('request.jwt.claims', {q(claims)}, true);",
        f"    execute 'set local role {role}';",
        f"    execute {q(sql)};",
        "    execute 'reset role'; v_err := null;",
        "  exception when others then execute 'reset role'; v_err := sqlerrm; end;",
        f"  v_results := v_results || jsonb_build_object('name', {q(name)}, 'ok', (v_err is null) = {str(ok).lower()}, 'detail', coalesce(v_err, 'succeeded'));",
    ]
lines += [
    "  raise exception 'DRYRUN_RESULTS:%', v_results::text;",
    "end",
    "$outer$;",
]
print("\n".join(lines))
