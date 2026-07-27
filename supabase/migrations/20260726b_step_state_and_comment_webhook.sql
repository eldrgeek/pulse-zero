-- Pulse Zero: persisted step-checkbox state + instant comment-answer webhook
-- (2026-07-26, second same-day pass). Applied live via the Supabase
-- Management API (same ad hoc pattern as the earlier 20260726 migration in
-- this dir) — this file exists so the change is reproducible.

-- ── Feature 1: persisted per-step checkbox state ────────────────────────
-- Frontend (ren's public/index.html) can now toggle an individual Yeshie
-- step's done/not-done state and have it stick across reloads, instead of
-- checkbox state living only in browser memory. Shape is intentionally
-- freeform ({stepIndex: bool} or {stepText: bool} — frontend's call) since
-- nothing server-side reads it; it's client-owned state parked on the row.
alter table public.pulse_cards
  add column if not exists step_state jsonb not null default '{}'::jsonb;

-- No new RLS needed: pulse_cards_mike_update (existing policy) already lets
-- mw@mike-wolf.com UPDATE any column on their own rows via a plain
-- `sb.from('pulse_cards').update({step_state: {...}}).eq('id', id)` client
-- call — the same pattern public/index.html already uses for
-- status/snoozed_until updates. No Netlify function required.

-- ── Feature 2: instant comment-answer trigger ───────────────────────────
-- Was: pulse-answer polls every 20-30min. Now: an INSERT on
-- pulse_card_comments fires immediately via pg_net -> a Netlify function
-- (netlify/functions/card-comment-webhook.js) -> a new mac_commands row
-- (command=answer_card_comment), which pulse-mac-bridge's existing 2s poll
-- picks up right away. The secret used to authenticate the outbound call is
-- stored in Supabase Vault (name='pulse_webhook_secret'), NOT committed here
-- — see README "Comments" section for the exact value's whereabouts
-- (Netlify site env PULSE_WEBHOOK_SECRET, same value).
create extension if not exists pg_net with schema extensions;

-- One-time, run once per project (already executed live 2026-07-26):
--   select vault.create_secret('<random-hex>', 'pulse_webhook_secret',
--     'Shared secret: pulse_card_comments insert trigger -> pulse-zero Netlify webhook function');
-- Rotate by: select vault.update_secret(<id>, '<new-random-hex>'); then
-- `netlify env:set PULSE_WEBHOOK_SECRET <same-new-value> --site pulse-zero`.

create or replace function public.notify_card_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault, net
as $fn$
declare
  secret text;
begin
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

drop trigger if exists pulse_card_comments_notify on public.pulse_card_comments;

create trigger pulse_card_comments_notify
  after insert on public.pulse_card_comments
  for each row execute function public.notify_card_comment_insert();

select pg_notify('pgrst', 'reload schema');
