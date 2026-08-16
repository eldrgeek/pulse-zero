-- Pulse One / frictionless-console-v1, Slice 1: trustworthy ratify
-- (2026-08-17. Mike-ratified card 913e36c5-7253-4341-a0a3-b45e499f554f,
-- spec SOMA/specs/frictionless-console-v1.md §5 slice 1.) Applied live via
-- the Supabase Management API — same ad hoc pattern as every prior migration
-- in this dir (see README "Comments" section) — this file exists so the
-- change is reproducible/reviewable.
--
-- Replaces the flapping pulse-realtime-watch websocket subscriber (109
-- CHANNEL_ERROR exits since 2026-08-13) with the same pg_net webhook pattern
-- that has run rock-solid for the comment-answer loop since 2026-07-26
-- (20260726b_step_state_and_comment_webhook.sql).

-- ── pulse_run_events: append-only ratify narration ──────────────────────
-- The card strip renders these live. Deliberately NOT mac_commands.result —
-- a ratify run is a multi-event stream (start -> progress -> receipt), not a
-- single request/response pair. Never UPDATE or DELETE a row here; a
-- narration line is a fact about what happened at a point in time, not
-- current state (rulebook #2 — state is not disposable build output).
create table if not exists public.pulse_run_events (
  id bigint generated always as identity primary key,
  card_id uuid not null references public.pulse_cards(id) on delete cascade,
  run_id text,
  ts timestamptz not null default now(),
  kind text not null check (kind in ('start', 'progress', 'receipt', 'stalled', 'error')),
  text text not null
);

create index if not exists pulse_run_events_card_id_ts
  on public.pulse_run_events (card_id, ts);

alter table public.pulse_run_events enable row level security;

-- Mike reads the board's events (board client renders the strip), same
-- single-tenant gate as every other pulse_* table (public.is_pulse_owner(),
-- 20260727_google_signin_owner_emails.sql); service role (webhook + workers)
-- inserts. No UPDATE/DELETE policy at all — append-only is enforced at the
-- RLS layer, not just by convention.
drop policy if exists pulse_run_events_mike_select on public.pulse_run_events;
create policy pulse_run_events_mike_select on public.pulse_run_events
  for select using (public.is_pulse_owner());

drop policy if exists pulse_run_events_service_insert on public.pulse_run_events;
create policy pulse_run_events_service_insert on public.pulse_run_events
  for insert
  with check (auth.role() = 'service_role');

-- ── instant act-on-answer trigger ────────────────────────────────────────
-- Was: pulse-realtime-watch, a Node websocket subscriber that flapped 109
-- CHANNEL_ERROR exits since 08-13 with no replay on reconnect (audit-pipeline.md
-- line 25). Now: an UPDATE on pulse_cards landing on answered/resolved/
-- retired/bounced fires immediately via pg_net -> a Netlify function
-- (netlify/functions/card-answer-webhook.js) -> pulse_run_events (first
-- narration row, written deterministically by the webhook, not the worker)
-- and a new mac_commands row (command=act_on_answer), which
-- pulse-mac-bridge's existing 2s poll picks up right away. Reuses the same
-- vault secret as the comment webhook (name='pulse_webhook_secret') and the
-- same Netlify site env (PULSE_WEBHOOK_SECRET, PULSE_ZERO_SERVICE_KEY) —
-- no new secret to provision or rotate.
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

drop trigger if exists pulse_cards_answer_notify on public.pulse_cards;

create trigger pulse_cards_answer_notify
  after update on public.pulse_cards
  for each row execute function public.notify_card_answer_update();

select pg_notify('pgrst', 'reload schema');
