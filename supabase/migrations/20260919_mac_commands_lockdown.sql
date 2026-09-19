-- 20260919_mac_commands_lockdown.sql — who may put what on the Mac's queue.
--
-- _Written 2026-09-19 by Claude (Opus 5, CCc) for Mike Wolf, fixing a finding
-- from OpenAI Astra's review of the Proof {do} design._
--
-- WHY. public.mac_commands is the queue pulse-mac-bridge executes on Mike's
-- Mac. Before this migration any principal that could INSERT a row could make
-- the Mac run a shell command (clipboard_take_and_deploy.verify_command ran
-- with shell=True), inject text into a Claude Desktop session, or send the
-- clipboard to an ssh host of its choosing. The principals that could INSERT
-- were: every Supabase secret key on this shared SOMA Auth project (seven on
-- 2026-09-19, several installed on unrelated Netlify sites and in CI; each is
-- service_role and bypasses RLS), and any session signed in with Mike's email
-- on ANY app that shares this project.
--
-- WHAT. RLS cannot restrict service_role, but a trigger can: triggers fire for
-- every role. So:
--   1. BEFORE INSERT: stamp provenance (enqueued_role, enqueued_email,
--      created_at, status) from the request's own auth context, then refuse
--      any command the enqueuing role may not issue:
--        service_role  -> open, speak, open_and_guide (http(s) URLs only),
--                         answer_card_comment, act_on_answer, escalate_question
--        Mike's JWT    -> execute_card_action (reviewed operation, bound to the
--                         exact action on an open card), open_session and
--                         clipboard_take_and_deploy (bound to a step action on
--                         an open card, stamped as a user click)
--        anyone else   -> nothing
--      verify_command, vps_env_file and clipboard_set are refused for everyone.
--   2. BEFORE UPDATE: provenance, command and payload are frozen. Only
--      status/result/executed_at may change, so a service key cannot swap the
--      payload of a row Mike enqueued.
--   3. RLS: Mike's session may SELECT and INSERT. UPDATE/DELETE are left to
--      service_role (the bridge and the smoke test), which RLS never governed.
-- pulse-mac-bridge re-checks the provenance columns before executing, so the
-- two boundaries hold independently.
--
-- Current user, not the JWT role claim, is the role source: PostgREST has
-- already SET ROLE from the verified JWT, and the functions below are SECURITY
-- INVOKER so current_user is that role.

alter table public.mac_commands
  add column if not exists enqueued_role text,
  add column if not exists enqueued_email text;

comment on column public.mac_commands.enqueued_role is
  'Database role that inserted the row, stamped by mac_commands_guard_insert. Callers cannot set or change it.';
comment on column public.mac_commands.enqueued_email is
  'Owner email from the inserting JWT when the inserter is Mike, else null. Stamped by the trigger; frozen.';

create or replace function public.mac_commands_guard_insert()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role text := current_user;
  v_p jsonb := coalesce(new.payload, '{}'::jsonb);
  v_card public.pulse_cards%rowtype;
  v_action jsonb;
  v_url text;
begin
  new.enqueued_role := v_role;
  new.enqueued_email := case
    when v_role = 'authenticated' and public.is_pulse_owner()
      then lower(auth.jwt() ->> 'email')
    else null
  end;
  new.created_at := now();
  new.status := 'open';
  new.result := null;
  new.executed_at := null;

  if jsonb_typeof(v_p) <> 'object' then
    raise exception 'mac_commands: payload must be a JSON object' using errcode = '22023';
  end if;
  if v_p ? 'verify_command' then
    raise exception 'mac_commands: verify_command is retired; use verify=site_http_ok'
      using errcode = '42501';
  end if;

  if v_role in ('service_role', 'postgres', 'supabase_admin') then
    if new.command not in ('open', 'speak', 'open_and_guide',
        'answer_card_comment', 'act_on_answer', 'escalate_question') then
      raise exception 'mac_commands: service producers may not enqueue %', new.command
        using errcode = '42501',
              hint = 'Foreground, clipboard and typed actions must come from Mike''s signed-in Pulse click.';
    end if;
    if new.command in ('open', 'open_and_guide') then
      v_url := v_p ->> 'url';
      if v_url is null or v_url !~ '^https?://[^/[:space:]]+' then
        raise exception 'mac_commands: % requires an absolute http(s) url', new.command
          using errcode = '22023';
      end if;
    end if;
    return new;
  end if;

  if v_role <> 'authenticated' or new.enqueued_email is null then
    raise exception 'mac_commands: only Pulse owner sessions and service producers may enqueue'
      using errcode = '42501';
  end if;

  if new.command = 'execute_card_action' then
    if new.pulse_card_id is null or new.pulse_action_id is null or
        new.pulse_revision is null or new.attempt is null or new.attempt < 1 then
      raise exception 'mac_commands: execute_card_action requires its typed columns'
        using errcode = '22023';
    end if;
    if new.idempotency_key is distinct from format('pulse-zero:%s:%s:r%s:a%s',
          new.pulse_card_id, new.pulse_action_id, new.pulse_revision, new.attempt) or
        v_p ->> 'idempotency_key' is distinct from new.idempotency_key or
        v_p ->> 'card_id' is distinct from new.pulse_card_id::text or
        v_p ->> 'action_id' is distinct from new.pulse_action_id or
        (v_p ->> 'revision') is distinct from new.pulse_revision::text or
        (v_p ->> 'contract_version') is distinct from '1' then
      raise exception 'mac_commands: execute_card_action payload disagrees with its typed columns'
        using errcode = '22023';
    end if;
    select * into v_card from public.pulse_cards
      where id = new.pulse_card_id and app_id = 'pulse-zero' and status = 'open';
    if not found then
      raise exception 'mac_commands: execute_card_action card is not open' using errcode = '42501';
    end if;
    select value into v_action
      from jsonb_array_elements(case when jsonb_typeof(v_card.payload -> 'actions') = 'array'
                                     then v_card.payload -> 'actions' else '[]'::jsonb end)
      where value ->> 'id' = new.pulse_action_id
      limit 1;
    if v_action is null or v_action is distinct from v_p -> 'action' then
      raise exception 'mac_commands: execute_card_action must carry the card''s own action unchanged'
        using errcode = '42501';
    end if;
    if (v_action ->> 'revision') is distinct from new.pulse_revision::text then
      raise exception 'mac_commands: stale action revision' using errcode = '22023';
    end if;
    if not (v_action ->> 'executor' = 'workflow' and
            v_action ->> 'operation' = 'gdoc_bridge_authorize' and
            v_action -> 'verification' ->> 'kind' = 'google_drive_about' and
            v_action -> 'human_gate' -> 'target' ->> 'ref' = 'google.oauth.consent.primary') then
      raise exception 'mac_commands: action operation is not reviewed' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.command in ('open_session', 'clipboard_take_and_deploy') then
    if v_p ->> 'interaction' is distinct from 'user_click' then
      raise exception 'mac_commands: % must be stamped as a user click', new.command
        using errcode = '42501';
    end if;
    if new.command = 'clipboard_take_and_deploy' and
        v_p -> 'destination' ->> 'type' not in ('group_bc_credential', 'netlify_env') then
      raise exception 'mac_commands: clipboard destination % is not allowed',
        coalesce(v_p -> 'destination' ->> 'type', 'null') using errcode = '42501';
    end if;
    if new.pulse_card_id is null or not exists (
        select 1
        from public.pulse_cards c,
             jsonb_array_elements(case when jsonb_typeof(c.payload -> 'step_actions') = 'array'
                                       then c.payload -> 'step_actions' else '[]'::jsonb end) a
        where c.id = new.pulse_card_id and c.app_id = 'pulse-zero' and c.status = 'open'
          and jsonb_typeof(a) = 'object'
          and a ->> 'command' = new.command
          and coalesce(a -> 'payload', '{}'::jsonb) = (v_p - 'interaction' - 'requested_at')) then
      raise exception 'mac_commands: % must match a step action on an open Pulse card', new.command
        using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'mac_commands: owner sessions may not enqueue %', new.command
    using errcode = '42501';
end;
$$;

create or replace function public.mac_commands_guard_update()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.id is distinct from old.id or
      new.command is distinct from old.command or
      new.payload is distinct from old.payload or
      new.created_at is distinct from old.created_at or
      new.enqueued_role is distinct from old.enqueued_role or
      new.enqueued_email is distinct from old.enqueued_email or
      new.pulse_card_id is distinct from old.pulse_card_id or
      new.pulse_action_id is distinct from old.pulse_action_id or
      new.pulse_revision is distinct from old.pulse_revision or
      new.attempt is distinct from old.attempt or
      new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'mac_commands: only status, result and executed_at may change'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists mac_commands_guard_insert on public.mac_commands;
create trigger mac_commands_guard_insert
  before insert on public.mac_commands
  for each row execute function public.mac_commands_guard_insert();

drop trigger if exists mac_commands_guard_update on public.mac_commands;
create trigger mac_commands_guard_update
  before update on public.mac_commands
  for each row execute function public.mac_commands_guard_update();

-- Trigger functions are not meant to be called directly.
revoke execute on function public.mac_commands_guard_insert() from public, anon, authenticated;
revoke execute on function public.mac_commands_guard_update() from public, anon, authenticated;

drop policy if exists mw_read_write on public.mac_commands;
drop policy if exists mac_commands_owner_select on public.mac_commands;
drop policy if exists mac_commands_owner_insert on public.mac_commands;
create policy mac_commands_owner_select on public.mac_commands
  for select to authenticated using (public.is_pulse_owner());
create policy mac_commands_owner_insert on public.mac_commands
  for insert to authenticated with check (public.is_pulse_owner());
revoke update, delete, truncate, references, trigger on public.mac_commands from authenticated;
revoke all on public.mac_commands from anon;
