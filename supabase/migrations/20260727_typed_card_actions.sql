-- Durable metadata for Pulse card-action runs.
--
-- mac_commands remains the transport and execution ledger. These additive
-- columns let the browser recover the exact run after a reload, reject a
-- duplicate click atomically, and distinguish a revised action from an older
-- receipt without putting execution state back into the card payload.

alter table public.mac_commands
  add column if not exists pulse_card_id uuid references public.pulse_cards(id) on delete set null,
  add column if not exists pulse_action_id text,
  add column if not exists pulse_revision integer,
  add column if not exists attempt integer,
  add column if not exists idempotency_key text;

create unique index if not exists mac_commands_idempotency_key_unique
  on public.mac_commands (idempotency_key)
  where idempotency_key is not null;

create index if not exists mac_commands_pulse_action_runs
  on public.mac_commands (pulse_card_id, pulse_action_id, pulse_revision, attempt desc)
  where pulse_card_id is not null;

comment on column public.mac_commands.pulse_card_id is
  'Pulse card that requested this typed action; null for legacy commands.';
comment on column public.mac_commands.pulse_action_id is
  'Stable payload.actions[].id within the Pulse card.';
comment on column public.mac_commands.pulse_revision is
  'Positive action revision; changing an action requires incrementing it.';
comment on column public.mac_commands.attempt is
  'One-based retry attempt. Reload/resume keeps the same attempt.';
comment on column public.mac_commands.idempotency_key is
  'Unique pulse-zero:<card>:<action>:r<revision>:a<attempt> command key.';
