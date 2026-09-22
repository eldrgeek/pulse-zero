-- 20260922_pulse_answer_provenance.sql — provenance for the two rows that
-- become an agentic worker's prompt.
--
-- _Written 2026-09-22 by Claude (Opus 5, CCc) for Mike Wolf, closing the
-- residual path pulse-mac-bridge/CONTRACT.md §0 named after the 2026-09-19
-- mac_commands lockdown._
--
-- WHY. The 09-19 lockdown stopped a Supabase secret key from making the Mac
-- run a shell command directly. It left the key able to make the Mac run an
-- AI worker on attacker-chosen text, which is the same capability with extra
-- steps:
--
--   INSERT pulse_card_comments (author: 'mike', body: <attacker text>)
--     -> pulse_card_comments_notify (pg_net)
--     -> netlify/functions/card-comment-webhook.js   [gate: author == 'mike']
--     -> INSERT mac_commands (answer_card_comment)   [allowed to service keys]
--     -> pulse-mac-bridge answer_card_comment
--     -> _estate/bin/pulse_common.dispatch_answer_worker
--     -> cc-dispatch -> claude -p --permission-mode bypassPermissions
--
-- That worker runs as Mike with no tool allowlist, so the body of a forged
-- comment reaches a shell holding his ssh keys, every .env under ~/Projects,
-- and his git and mail credentials. No human is in the loop at any step. The
-- only gate was the `author` column, which is caller-supplied text, so it was
-- never provenance. PATCHing pulse_cards.answer reaches the act-on-answer
-- worker (_estate/bin/pulse-act) the same way, and that prompt tells the
-- worker the answer is "an authorization to execute".
--
-- WHAT. Same shape as mac_commands_guard_insert: RLS cannot restrict
-- service_role, but a trigger fires for every role.
--   1. pulse_card_comments BEFORE INSERT: stamp authored_role, authored_email
--      and created_at from the request's own auth context, then REFUSE any row
--      whose `author` claims to be Mike unless the inserter is Mike's
--      signed-in Pulse session. A service key may still write replies
--      (author=dee and friends). It simply cannot speak as Mike.
--   2. pulse_card_comments BEFORE UPDATE: card_id, author, body, created_at
--      and the provenance columns are frozen, so a service key cannot rewrite
--      one of Mike's real comments into an instruction after the fact.
--   3. pulse_cards BEFORE UPDATE: stamp answered_role and answered_email
--      whenever answer, answered_at, or an answered-ish status changes. This
--      trigger only records, it never refuses, because pulse-answer-write
--      legitimately captures in-session answers with the service key. The
--      consumers decide what deserves a dispatch.
--   4. Both pg_net webhooks fire only for owner-stamped rows, so a forged row
--      never reaches the Netlify function at all.
-- The consumers (bridge.py, pulse-answer, pulse-act) re-check the stamped
-- columns before dispatching, so the two boundaries hold independently.
--
-- Current user, not the JWT role claim, is the role source: PostgREST has
-- already SET ROLE from the verified JWT and these functions are SECURITY
-- INVOKER, so current_user is that role.

alter table public.pulse_card_comments
  add column if not exists authored_role text,
  add column if not exists authored_email text;

comment on column public.pulse_card_comments.authored_role is
  'Database role that inserted the comment, stamped by pulse_card_comments_guard_insert. Callers cannot set or change it.';
comment on column public.pulse_card_comments.authored_email is
  'Owner email from the inserting JWT when the inserter is Mike, else null. Stamped by the trigger; frozen on UPDATE.';

alter table public.pulse_cards
  add column if not exists answered_role text,
  add column if not exists answered_email text;

comment on column public.pulse_cards.answered_role is
  'Database role that last wrote answer/answered_at/an answered status, stamped by pulse_cards_stamp_answer. Records only; the trigger never refuses a write.';
comment on column public.pulse_cards.answered_email is
  'Owner email from the JWT that last answered, when that was Mike. Stamped by the trigger; a service role cannot forge it.';

-- Author strings that assert the row is Mike speaking. `author` is free text
-- and the whole board reads 'mike' as him (pulse-answer's MIKE_AUTHOR,
-- card-comment-webhook.js's filter), so every spelling of it is reserved.
create or replace function public.pulse_author_claims_owner(p_author text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select btrim(lower(coalesce(p_author, ''))) in
    ('mike', 'mw', 'mike wolf', 'mikewolf', 'mike_wolf', 'mike-wolf',
     'owner', 'mw@mike-wolf.com', 'mw.personalmail@gmail.com');
$$;

revoke execute on function public.pulse_author_claims_owner(text) from public, anon;
grant execute on function public.pulse_author_claims_owner(text) to authenticated, service_role;

create or replace function public.pulse_card_comments_guard_insert()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role text := current_user;
  v_owner boolean := current_user = 'authenticated' and public.is_pulse_owner();
begin
  new.authored_role := v_role;
  new.authored_email := case when v_owner then lower(auth.jwt() ->> 'email') else null end;
  new.created_at := now();

  if public.pulse_author_claims_owner(new.author) and not v_owner then
    raise exception 'pulse_card_comments: author % may only be used by Mike''s signed-in Pulse session (this insert was role=%)',
      new.author, v_role
      using errcode = '42501',
            hint = 'A comment attributed to Mike dispatches an agentic worker on its body. Service producers must use their own author, e.g. dee.';
  end if;

  return new;
end;
$$;

create or replace function public.pulse_card_comments_guard_update()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.id is distinct from old.id or
      new.card_id is distinct from old.card_id or
      new.author is distinct from old.author or
      new.body is distinct from old.body or
      new.created_at is distinct from old.created_at or
      new.authored_role is distinct from old.authored_role or
      new.authored_email is distinct from old.authored_email then
    raise exception 'pulse_card_comments: comments are append-only; this row may not be rewritten'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.pulse_cards_stamp_answer()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role text := current_user;
  v_owner boolean := current_user = 'authenticated' and public.is_pulse_owner();
begin
  if new.answer is distinct from old.answer
     or new.answered_at is distinct from old.answered_at
     or (new.status is distinct from old.status
         and new.status in ('answered', 'resolved', 'retired', 'bounced')) then
    new.answered_role := v_role;
    new.answered_email := case when v_owner then lower(auth.jwt() ->> 'email') else null end;
  else
    -- Not an answer write: the existing stamp is frozen.
    new.answered_role := old.answered_role;
    new.answered_email := old.answered_email;
  end if;
  return new;
end;
$$;

drop trigger if exists pulse_card_comments_guard_insert on public.pulse_card_comments;
create trigger pulse_card_comments_guard_insert
  before insert on public.pulse_card_comments
  for each row execute function public.pulse_card_comments_guard_insert();

drop trigger if exists pulse_card_comments_guard_update on public.pulse_card_comments;
create trigger pulse_card_comments_guard_update
  before update on public.pulse_card_comments
  for each row execute function public.pulse_card_comments_guard_update();

drop trigger if exists pulse_cards_stamp_answer on public.pulse_cards;
create trigger pulse_cards_stamp_answer
  before update on public.pulse_cards
  for each row execute function public.pulse_cards_stamp_answer();

-- Trigger functions are not meant to be called directly.
revoke execute on function public.pulse_card_comments_guard_insert() from public, anon, authenticated;
revoke execute on function public.pulse_card_comments_guard_update() from public, anon, authenticated;
revoke execute on function public.pulse_cards_stamp_answer() from public, anon, authenticated;

-- Webhook narrowing. Both notify functions are SECURITY DEFINER and fire
-- after the guards above, so they can trust the stamped columns. A row that is
-- not Mike's own no longer reaches the Netlify function; that function's own
-- author filter stays as the second check.
create or replace function public.notify_card_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault, net
as $fn$
declare
  secret text;
begin
  -- Only Mike's own signed-in comment dispatches a worker (2026-09-22).
  if new.authored_role is distinct from 'authenticated' or new.authored_email is null then
    return new;
  end if;
  select decrypted_secret into secret from vault.decrypted_secrets
    where name = 'pulse_webhook_secret' limit 1;
  if secret is not null then
    -- pg_net is async (queues the request, doesn't block this INSERT).
    perform net.http_post(
      url := 'https://pulse-zero.netlify.app/.netlify/functions/card-comment-webhook',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-pulse-secret', secret),
      body := jsonb_build_object('comment_id', new.id, 'card_id', new.card_id, 'author', new.author)
    );
  end if;
  return new;
end;
$fn$;

create or replace function public.notify_card_answer_update()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault, net
as $fn$
declare
  secret text;
begin
  if new.status = old.status then
    return new;
  end if;
  if new.status not in ('answered', 'resolved', 'retired', 'bounced') then
    return new;
  end if;
  -- Only an answer Mike wrote himself dispatches the act-on-answer worker
  -- (2026-09-22). pulse-answer-write's in-session captures are service-role
  -- and pulse-act already skipped them downstream; now they never fire.
  if new.answered_role is distinct from 'authenticated' or new.answered_email is null then
    return new;
  end if;
  select decrypted_secret into secret from vault.decrypted_secrets
    where name = 'pulse_webhook_secret' limit 1;
  if secret is not null then
    -- pg_net is async (queues the request, doesn't block this UPDATE).
    perform net.http_post(
      url := 'https://pulse-zero.netlify.app/.netlify/functions/card-answer-webhook',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-pulse-secret', secret),
      body := jsonb_build_object('card_id', new.id, 'status', new.status, 'run_id', gen_random_uuid()::text)
    );
  end if;
  return new;
end;
$fn$;

select pg_notify('pgrst', 'reload schema');
