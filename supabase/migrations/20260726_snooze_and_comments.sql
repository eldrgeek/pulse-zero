-- Pulse Zero: snooze + comment threads (2026-07-26)
-- Applied live via the Supabase Management API (see PR/session notes — this
-- repo's migration history is ad hoc, not `supabase db push`-managed; this
-- file exists so the change is reproducible, per README "Schema" section).

-- ── Feature 1: snooze ────────────────────────────────────────────────
-- A snoozed OPEN card is hidden from the default board view until
-- snoozed_until passes, then it reappears as a normal open card. Status
-- stays 'open' the whole time — snoozing is not a status, it's a visibility
-- window layered on top of 'open'. Additive, nullable, no backfill needed.
alter table public.pulse_cards
  add column if not exists snoozed_until timestamptz;

-- ── Feature 2: comment threads ──────────────────────────────────────
-- Separate table (not jsonb-on-card) so realtime can push individual new
-- comments and RLS can be scoped independently. FK enables PostgREST
-- embedding: `pulse_cards?select=*,pulse_card_comments(*)`.
create table if not exists public.pulse_card_comments (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.pulse_cards(id) on delete cascade,
  author text not null default 'mike',
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists pulse_card_comments_card_id_idx
  on public.pulse_card_comments (card_id);

alter table public.pulse_card_comments enable row level security;

-- Mirrors pulse_cards' policy shape exactly (service_role full access,
-- mw@mike-wolf.com scoped to their own use of the board — there is only one
-- human user of this board, so select/insert are open to that one email,
-- same trust boundary as pulse_cards_mike_update).
create policy pulse_card_comments_service_role_all
  on public.pulse_card_comments
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy pulse_card_comments_mike_select
  on public.pulse_card_comments
  for select
  using ((auth.jwt() ->> 'email') = 'mw@mike-wolf.com');

create policy pulse_card_comments_mike_insert
  on public.pulse_card_comments
  for insert
  with check ((auth.jwt() ->> 'email') = 'mw@mike-wolf.com');

-- Realtime: pulse_cards was already added to this publication 2026-07-26
-- (earlier same-day fix — it was missing, which is why the board never
-- live-updated). Any NEW table needs the same treatment or it will silently
-- fail to push updates.
alter publication supabase_realtime add table public.pulse_card_comments;

-- Nudge PostgREST to pick up the new table/column immediately rather than
-- waiting for its own schema-cache poll interval.
select pg_notify('pgrst', 'reload schema');
