-- Google sign-in for Pulse Zero (2026-07-27)
--
-- Pulse's gate was the literal string 'mw@mike-wolf.com' repeated across six
-- policies. That is fine for magic link (Mike types that address) but breaks
-- the moment he signs in with "Continue with Google": Google may hand back
-- either of his two identities, and the personal Gmail is the better-
-- provisioned one for Google-native flows (see SOMA reference: Google account
-- topology). A Google session on the personal account would have rendered an
-- empty board with no explanation.
--
-- Both addresses are Mike's own. The board is still single-tenant; this widens
-- it from one of his emails to both, and moves the list into one function so
-- the next change is a one-liner instead of six policy rewrites.

create or replace function public.is_pulse_owner()
returns boolean
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'mw@mike-wolf.com',
    'mw.personalmail@gmail.com'
  );
$$;

grant execute on function public.is_pulse_owner() to authenticated, anon, service_role;

-- pulse_cards
drop policy if exists pulse_cards_mike_select on public.pulse_cards;
create policy pulse_cards_mike_select on public.pulse_cards
  for select using (public.is_pulse_owner());

drop policy if exists pulse_cards_mike_update on public.pulse_cards;
create policy pulse_cards_mike_update on public.pulse_cards
  for update using (public.is_pulse_owner())
  with check (public.is_pulse_owner());

-- pulse_card_comments
drop policy if exists pulse_card_comments_mike_select on public.pulse_card_comments;
create policy pulse_card_comments_mike_select on public.pulse_card_comments
  for select using (public.is_pulse_owner());

drop policy if exists pulse_card_comments_mike_insert on public.pulse_card_comments;
create policy pulse_card_comments_mike_insert on public.pulse_card_comments
  for insert with check (public.is_pulse_owner());

-- pulse_zero_feedback (soma-feedback chip inbox — read-only for Mike)
drop policy if exists mike_select on public.pulse_zero_feedback;
create policy mike_select on public.pulse_zero_feedback
  for select using (public.is_pulse_owner());
