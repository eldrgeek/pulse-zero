-- test_card_gate.sql — assertions for the Pulse card contract DB gate.
--
-- Tests the REAL artifact: it \ir-includes
-- ../supabase/migrations/UNAPPLIED-20260801_pulse_card_contract_gate.sql.draft
-- rather than a copy, so the file that would eventually be applied is the file
-- under test.
--
-- NEVER run this against the shared project. It creates and writes to a table
-- named `public.pulse_cards`. Run it against a throwaway database only:
--
--   initdb -D /tmp/pgdata -U postgres --auth-local=trust
--   pg_ctl -D /tmp/pgdata -o "-p 55432 -c listen_addresses=127.0.0.1 \
--          -c unix_socket_directories=" -l /tmp/pg.log start
--   createdb -h 127.0.0.1 -p 55432 -U postgres pulse_shadow
--   psql -h 127.0.0.1 -p 55432 -U postgres -d pulse_shadow \
--        -v ON_ERROR_STOP=1 -f test/test_card_gate.sql
--
-- Exits non-zero if any assertion fails.

\set ON_ERROR_STOP on

-- Refuse to run anywhere that already holds real cards. Rows left by a previous
-- run of this very file are cleared instead, so the suite is re-runnable.
do $$
begin
  if to_regclass('public.pulse_cards') is not null then
    if exists (select 1 from public.pulse_cards
                where coalesce(created_by, '') not in
                      ('gate-test', 'legacy-bypasser', 'post-rollback')) then
      raise exception
        'REFUSING TO RUN: public.pulse_cards contains rows this test did not '
        'create. This test writes to that table and is for a throwaway '
        'database only.';
    end if;
    delete from public.pulse_cards
     where coalesce(created_by, '') in
           ('gate-test', 'legacy-bypasser', 'post-rollback');
  end if;
end;
$$;

-- ── Base schema, reconstructed from README §Schema + the four applied
--    migrations. Only the columns the gate and the board UPDATE paths touch
--    matter; the rest are present so the test exercises realistic rows.
create table if not exists public.pulse_cards (
  id            uuid primary key default gen_random_uuid(),
  app_id        text not null default 'pulse-zero',
  type          text not null,
  payload       jsonb,
  status        text not null default 'open'
                check (status in ('open','answered','retired','bounced','resolved')),
  answer        jsonb,
  created_by    text,
  created_at    timestamptz not null default now(),
  answered_at   timestamptz,
  bounce_reason text,
  resolved_note text,
  yeshie_steps  text,
  yeshie_task   jsonb,
  dedupe_key    text,
  snoozed_until timestamptz,
  step_state    jsonb
);

-- ── The artifact under test ────────────────────────────────────────────────
\ir ../supabase/migrations/UNAPPLIED-20260801_pulse_card_contract_gate.sql.draft

-- ── Harness ────────────────────────────────────────────────────────────────
create table if not exists public.gate_test_log (
  n      serial primary key,
  label  text,
  passed boolean,
  detail text
);
delete from public.gate_test_log where n > 0;
alter sequence public.gate_test_log_n_seq restart with 1;

-- Insert must SUCCEED.
create or replace function public.t_ok(label text, p_type text, p_payload jsonb)
returns void language plpgsql as $$
begin
  begin
    insert into public.pulse_cards (type, payload, created_by)
    values (p_type, p_payload, 'gate-test');
    insert into public.gate_test_log (label, passed, detail) values (label, true, 'inserted');
  exception when others then
    insert into public.gate_test_log (label, passed, detail)
    values (label, false, 'UNEXPECTED REJECTION: ' || sqlerrm);
  end;
end;
$$;

-- Insert must FAIL, and the message must name `expect_rule`.
create or replace function public.t_fail(label text, p_type text, p_payload jsonb, expect_rule text)
returns void language plpgsql as $$
declare msg text;
begin
  begin
    insert into public.pulse_cards (type, payload, created_by)
    values (p_type, p_payload, 'gate-test');
    insert into public.gate_test_log (label, passed, detail)
    values (label, false, 'EXPECTED REJECTION, ROW WAS ACCEPTED');
    return;
  exception when others then
    msg := sqlerrm;
  end;
  if position('[' || expect_rule || ']' in msg) = 0 then
    insert into public.gate_test_log (label, passed, detail)
    values (label, false, format('rejected but wrong rule (wanted [%s]): %s', expect_rule, msg));
  elsif position('pulse-zero/README.md' in msg) = 0 then
    insert into public.gate_test_log (label, passed, detail)
    values (label, false, 'rejected with the right rule but no README pointer: ' || msg);
  elsif position(p_type in msg) = 0 and expect_rule <> 'unknown_card_type' then
    insert into public.gate_test_log (label, passed, detail)
    values (label, false, 'rejected but message does not name the card type: ' || msg);
  else
    insert into public.gate_test_log (label, passed, detail)
    values (label, true, left(msg, 120));
  end if;
end;
$$;

create or replace function public.t_assert(label text, cond boolean, detail text default '')
returns void language sql as $$
  insert into public.gate_test_log (label, passed, detail) values (label, cond, detail);
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- A. The four canonical pulse-push shapes pass.
-- ════════════════════════════════════════════════════════════════════════════
select public.t_ok('A1 action (pulse-push canonical)', 'action', jsonb_build_object(
  'title', 'Approve the Netlify deploy',
  'why',   'Blocks the Legends launch',
  'steps', E'1. Open the deploy\n2. Click Publish',
  'url',   'https://app.netlify.com'));

select public.t_ok('A2 decision (pulse-push canonical)', 'decision', jsonb_build_object(
  'question', 'Ship the redesign now or after AGI-26?',
  'options',  jsonb_build_array('Ship now', 'Wait'),
  'why',      'Greg is waiting on the answer',
  'url',      'https://example.invalid/writeup'));

select public.t_ok('A3 verdict (pulse-push canonical)', 'verdict', jsonb_build_object(
  'artifact_name', 'STRIPPED-2026-07-15.md',
  'url',           'https://github.com/eldrgeek/pulse-zero',
  'summary',       'Pulse stripped to 4 card types.'));

select public.t_ok('A4 brief (pulse-push canonical)', 'brief', jsonb_build_object(
  'title', 'Good morning, Mike.',
  'lines', E'3 open cards\n1 needs you today'));

-- Minimal legal shapes: only the required keys.
select public.t_ok('A5 action, title only (steps/why/url optional)', 'action',
  '{"title": "Accept the GitHub org invite"}'::jsonb);
select public.t_ok('A6 decision, no why/url', 'decision',
  '{"question": "Merge or rebase?", "options": ["Merge", "Rebase"]}'::jsonb);

-- Typed-action and step-action cards are NOT deep-validated here, by design.
select public.t_ok('A7 action with typed actions passes untyped-checked', 'action', jsonb_build_object(
  'title', 'Run the deploy',
  'actions_version', 1,
  'actions', jsonb_build_array(jsonb_build_object('id', 'a1', 'nonsense', true))));


-- ════════════════════════════════════════════════════════════════════════════
-- B. pulse-drain escalation shapes pass. THIS IS THE REGRESSION THAT MATTERS:
--    the nightly escalator writes an intentionally long banner title.
-- ════════════════════════════════════════════════════════════════════════════
select public.t_ok('B1 drain escalation, 85-char action title', 'action', jsonb_build_object(
  'title', '⏫ Day 2 — still waiting: still waiting: Phone test: chat with Gemma offline (air',
  'why',   'still open 3.1d',
  'steps', E'1. Open the app\n2. Toggle airplane mode',
  'url',   'https://example.invalid',
  'escalation_day', 2,
  'orig_key', '3c100931-0000-0000-0000-000000000000'));

select public.t_ok('B2 drain escalation, 95-char decision question', 'decision', jsonb_build_object(
  'question', '⏫ Day 1 — still waiting: Book the Greg call? (Legends #1 — prep is fully drafted)',
  'options',  jsonb_build_array('Book it', 'Not yet'),
  'escalation_day', 1,
  'orig_key', 'c9624139-0000-0000-0000-000000000000'));

select public.t_ok('B3 drain escalation, banner in artifact_name', 'verdict', jsonb_build_object(
  'artifact_name', '⏫ Day 1 — still waiting: The Shape of a Partnership (13-min, four voices)',
  'url',           'https://soma-briefings-esr.netlify.app/partnership/',
  'summary',       'Four-voice Lessig cut.',
  'escalation_day', 1,
  'orig_key', '700647a6-0000-0000-0000-000000000000'));

-- Explicit proof the 60-char board standard is NOT enforced at the DB tier.
select public.t_ok('B4 61-char action title passes (60 is CLI-only)', 'action',
  jsonb_build_object('title', repeat('x', 61)));
select public.t_ok('B5 61-char brief title passes (60 is CLI-only)', 'brief',
  jsonb_build_object('title', repeat('x', 61), 'lines', 'a line'));
select public.t_ok('B6 559-char decision question passes (never capped)', 'decision',
  jsonb_build_object('question', repeat('q', 559), 'options', jsonb_build_array('Yes', 'No')));


-- ════════════════════════════════════════════════════════════════════════════
-- C. Required-key omission fails, per type, per key.
-- ════════════════════════════════════════════════════════════════════════════
select public.t_fail('C1 action without title', 'action',
  '{"steps": "1. do a thing", "why": "because"}'::jsonb, 'required_field');
select public.t_fail('C2 decision without question', 'decision',
  '{"options": ["A", "B"]}'::jsonb, 'required_field');
select public.t_fail('C3 decision without options', 'decision',
  '{"question": "A or B?"}'::jsonb, 'required_field');
select public.t_fail('C4 verdict without artifact_name', 'verdict',
  '{"url": "https://x.invalid", "summary": "s"}'::jsonb, 'required_field');
select public.t_fail('C5 verdict without url', 'verdict',
  '{"artifact_name": "a", "summary": "s"}'::jsonb, 'required_field');
select public.t_fail('C6 verdict without summary', 'verdict',
  '{"artifact_name": "a", "url": "https://x.invalid"}'::jsonb, 'required_field');
select public.t_fail('C7 brief without title', 'brief',
  '{"lines": "a line"}'::jsonb, 'required_field');
select public.t_fail('C8 brief without lines', 'brief',
  '{"title": "Morning"}'::jsonb, 'required_field');
-- The README's wrong key name must not sneak through.
select public.t_fail('C9 verdict using README''s wrong key `artifact`', 'verdict',
  '{"artifact": "a", "url": "https://x.invalid", "summary": "s"}'::jsonb, 'required_field');


-- ════════════════════════════════════════════════════════════════════════════
-- D. Present-but-empty is missing.
-- ════════════════════════════════════════════════════════════════════════════
select public.t_fail('D1 action title empty string', 'action',
  '{"title": ""}'::jsonb, 'required_field');
select public.t_fail('D2 action title whitespace only', 'action',
  '{"title": "   "}'::jsonb, 'required_field');
select public.t_fail('D3 action title JSON null', 'action',
  '{"title": null}'::jsonb, 'required_field');
select public.t_fail('D4 decision options empty array', 'decision',
  '{"question": "A or B?", "options": []}'::jsonb, 'required_field');
select public.t_fail('D5 brief lines empty', 'brief',
  '{"title": "Morning", "lines": ""}'::jsonb, 'required_field');


-- ════════════════════════════════════════════════════════════════════════════
-- E. Payload shape.
-- ════════════════════════════════════════════════════════════════════════════
select public.t_fail('E1 empty object payload', 'action', '{}'::jsonb, 'empty_payload');
select public.t_fail('E2 SQL null payload', 'action', null::jsonb, 'empty_payload');
select public.t_fail('E3 JSON null payload', 'action', 'null'::jsonb, 'empty_payload');
select public.t_fail('E4 array payload', 'action', '["title"]'::jsonb, 'payload_shape');
select public.t_fail('E5 scalar payload', 'action', '"just a string"'::jsonb, 'payload_shape');


-- ════════════════════════════════════════════════════════════════════════════
-- F. Card type.
-- ════════════════════════════════════════════════════════════════════════════
select public.t_fail('F1 unknown type', 'reminder',
  '{"title": "Water the plants"}'::jsonb, 'unknown_card_type');
select public.t_fail('F2 null type', null,
  '{"title": "Water the plants"}'::jsonb, 'unknown_card_type');
select public.t_fail('F3 case-mismatched type', 'Action',
  '{"title": "Water the plants"}'::jsonb, 'unknown_card_type');


-- ════════════════════════════════════════════════════════════════════════════
-- G. VALUE TYPES ARE NOT CHECKED AT THE DB TIER — and that is the point.
--
--    Two rules were drafted here and CUT. A differential fuzz of 1157 payloads
--    through both tiers (Python pulse_card_contract.validate_payload at
--    title_max 60 and 160, vs. pulse_card_contract_violation) proved each one
--    rejects payloads the application contract ACCEPTS:
--
--      options_shape — 16 cases. `{"options": 0}`: Python's
--        `opts = payload.get("options") or []` collapses 0 to [] before the
--        isinstance check, so the app accepts it.
--      field_type    — 168 cases. The app type-checks nothing but action.title,
--        and does that only incidentally (`.strip()` raises AttributeError, not
--        CardContractError). `{"question": 42}` passes validate_payload today.
--
--    A DB rule stricter than the app tier is what silently kills a sanctioned
--    producer. These tests pin the weakening in place: if someone re-adds
--    either rule without first tightening Python, these go red.
--    Regenerate the fuzz before adding ANY rule here. "Obviously safe" is not
--    a proof — both of these looked obviously safe.
-- ════════════════════════════════════════════════════════════════════════════
select public.t_ok('G1 options as a CSV string passes the DB tier (app catches it)', 'decision',
  '{"question": "A or B?", "options": "A,B"}'::jsonb);
select public.t_ok('G2 options: 0 passes (matches the app tier bug-for-bug)', 'decision',
  '{"question": "A or B?", "options": 0}'::jsonb);
select public.t_ok('G3 numeric question passes (app accepts it today)', 'decision',
  '{"question": 42, "options": ["A", "B"]}'::jsonb);
select public.t_ok('G4 array lines passes (app accepts it today)', 'brief',
  '{"title": "Morning", "lines": ["a", "b"]}'::jsonb);
select public.t_ok('G5 object artifact_name passes (app accepts it today)', 'verdict',
  '{"artifact_name": {"n": "a"}, "url": "https://x.invalid", "summary": "s"}'::jsonb);


-- ════════════════════════════════════════════════════════════════════════════
-- H. TIER B — the runaway fence, not the board standard.
-- ════════════════════════════════════════════════════════════════════════════
select public.t_ok('H1 240-char action title passes (at the fence)', 'action',
  jsonb_build_object('title', repeat('y', 240)));
select public.t_fail('H2 241-char action title fails', 'action',
  jsonb_build_object('title', repeat('y', 241)), 'action_title_runaway');
-- Compounding simulation: 25-char banner re-applied nightly from an 85-char
-- base. Day 7 is the first night that trips the fence.
select public.t_ok('H3 day-6 compounded title (235) still passes', 'action',
  jsonb_build_object('title', repeat('⏫ Day N — still waiting: ', 6) || repeat('z', 85)));


-- ════════════════════════════════════════════════════════════════════════════
-- I. THE UPDATE REGRESSION. A row that would FAIL the INSERT gate must still be
--    fully manageable from Mike's board: answer, bounce, retire, resolve,
--    snooze, step_state, and pulse-push's in-place dedup PATCH.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.pulse_cards disable trigger pulse_card_contract_gate;
insert into public.pulse_cards (id, type, payload, created_by, status)
values ('11111111-1111-1111-1111-111111111111', 'action',
        '{"steps": "no title at all — this row would be rejected on INSERT"}'::jsonb,
        'legacy-bypasser', 'open');
insert into public.pulse_cards (id, type, payload, created_by, status)
values ('22222222-2222-2222-2222-222222222222', 'reminder', '{}'::jsonb,
        'legacy-bypasser', 'open');
alter table public.pulse_cards enable trigger pulse_card_contract_gate;

-- Prove the gate is live again before testing UPDATEs through it.
select public.t_fail('I0 gate is re-enabled', 'action', '{}'::jsonb, 'empty_payload');

do $$
declare bad uuid := '11111111-1111-1111-1111-111111111111';
        worse uuid := '22222222-2222-2222-2222-222222222222';
begin
  -- answerByMike(): status -> answered
  begin
    update public.pulse_cards
       set status = 'answered', answer = '{"action_id":"ok"}'::jsonb, answered_at = now()
     where id = bad;
    perform public.t_assert('I1 answer an un-insertable row', true);
  exception when others then
    perform public.t_assert('I1 answer an un-insertable row', false, sqlerrm);
  end;

  -- bounceByMike(): status -> bounced
  begin
    update public.pulse_cards set status = 'open' where id = bad;
    update public.pulse_cards
       set status = 'bounced', bounce_reason = 'Not mine (Mike)', answered_at = now()
     where id = bad;
    perform public.t_assert('I2 bounce an un-insertable row', true);
  exception when others then
    perform public.t_assert('I2 bounce an un-insertable row', false, sqlerrm);
  end;

  -- retire / resolve
  begin
    update public.pulse_cards set status = 'retired' where id = bad;
    update public.pulse_cards
       set status = 'resolved', resolved_note = 'All actions verified.' where id = bad;
    perform public.t_assert('I3 retire+resolve an un-insertable row', true);
  exception when others then
    perform public.t_assert('I3 retire+resolve an un-insertable row', false, sqlerrm);
  end;

  -- snooze / unsnooze
  begin
    update public.pulse_cards set status = 'open', snoozed_until = now() + interval '1 day' where id = bad;
    update public.pulse_cards set snoozed_until = null where id = bad;
    perform public.t_assert('I4 snooze/unsnooze an un-insertable row', true);
  exception when others then
    perform public.t_assert('I4 snooze/unsnooze an un-insertable row', false, sqlerrm);
  end;

  -- step_state checkbox writes
  begin
    update public.pulse_cards set step_state = '{"0": true}'::jsonb where id = bad;
    perform public.t_assert('I5 step_state write on an un-insertable row', true);
  exception when others then
    perform public.t_assert('I5 step_state write on an un-insertable row', false, sqlerrm);
  end;

  -- pulse-push dedup path: in-place PATCH of payload, still invalid afterwards.
  begin
    update public.pulse_cards
       set payload = '{"steps": "still no title"}'::jsonb, step_state = '{}'::jsonb
     where id = bad;
    perform public.t_assert('I6 pulse-push dedup PATCH keeps working', true);
  exception when others then
    perform public.t_assert('I6 pulse-push dedup PATCH keeps working', false, sqlerrm);
  end;

  -- An unknown *type* row must also stay dismissible.
  begin
    update public.pulse_cards set status = 'retired' where id = worse;
    perform public.t_assert('I7 retire a row with an unknown type', true);
  exception when others then
    perform public.t_assert('I7 retire a row with an unknown type', false, sqlerrm);
  end;
end;
$$;

-- The gate must be INSERT-only: assert no trigger fires on any other event.
select public.t_assert(
  'I8 exactly one trigger, BEFORE INSERT ROW, nothing else',
  (select count(*) = 1 from pg_trigger t
     where t.tgrelid = 'public.pulse_cards'::regclass
       and not t.tgisinternal
       and t.tgname = 'pulse_card_contract_gate'
       -- pg_trigger.tgtype bits: ROW=1, BEFORE=2, INSERT=4.
       -- BEFORE INSERT FOR EACH ROW == 7. Any UPDATE (16), DELETE (8) or
       -- TRUNCATE (32) bit, or AFTER (BEFORE bit unset), fails this.
       and t.tgtype = 7),
  (select coalesce(string_agg(tgname || ':' || tgtype, ', '), 'none')
     from pg_trigger where tgrelid = 'public.pulse_cards'::regclass and not tgisinternal));

-- Rollback must be a single statement and must fully disable enforcement.
drop trigger if exists pulse_card_contract_gate on public.pulse_cards;
do $$
begin
  insert into public.pulse_cards (type, payload, created_by)
  values ('reminder', '{}'::jsonb, 'post-rollback');
  perform public.t_assert('I9 DROP TRIGGER fully reverses the gate', true);
exception when others then
  perform public.t_assert('I9 DROP TRIGGER fully reverses the gate', false, sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- Report
-- ════════════════════════════════════════════════════════════════════════════
\echo ''
\echo '── FAILURES (empty = all green) ──'
select n, label, detail from public.gate_test_log where not passed order by n;
\echo ''
select count(*) filter (where passed) as passed,
       count(*) filter (where not passed) as failed,
       count(*) as total
  from public.gate_test_log;

do $$
declare f integer;
begin
  select count(*) into f from public.gate_test_log where not passed;
  if f > 0 then
    raise exception 'test_card_gate.sql: % assertion(s) FAILED', f;
  end if;
  raise notice 'test_card_gate.sql: all assertions passed';
end;
$$;
