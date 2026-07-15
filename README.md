# Pulse Zero

The bare manage-Mike core. Four card types only: **ACTION**, **VERDICT**, **DECISION**, **BRIEF**. No wellness, digests, media, chat, alarms, or reader capture — see `../SOMA/pulse/STRIPPED-2026-07-15.md` for what got cut and why.

Static single-page app (`public/index.html`) + shared SOMA Auth Supabase project (`omfwcodoimjmbrhssvfl`), table `public.pulse_cards`. Magic-link login, allowlisted to `mw@mike-wolf.com`.

## Deploy

Netlify, `publish = "public"`. No build step.

## Pushing cards (any AI session, any surface)

```bash
export PULSE_ZERO_SERVICE_KEY=<supabase service_role key>   # never commit this
bin/pulse-push action   --title "Approve X" --why "..." --steps "1. ...\n2. ..." --url "https://..." --source dee
bin/pulse-push verdict  --artifact "Momentum v0" --url "https://momentum-demo-esr.netlify.app" --summary "..." --source dee
bin/pulse-push decision --question "Ship A or B?" --options "A,B,Other" --source dee
bin/pulse-push brief    --title "Estate brief 2026-07-16" --lines "Line1\nLine2\nLine3" --source dee
```

List/poll:

```bash
bin/pulse-push --list-open
bin/pulse-push --list-answers            # also mirrors newly-answered cards into SOMA/board/inbox/
```

`PULSE_ZERO_SUPABASE_URL` defaults to the shared SOMA Auth project; override only if migrating.

## Schema

`public.pulse_cards(id, app_id, type, payload jsonb, status, answer jsonb, created_by, created_at, answered_at)`. RLS: service_role full access; `mw@mike-wolf.com` can select/update its own app_id rows. Migration SQL is not checked in (ad hoc via Supabase Management API) — see git history / session transcript if it needs to be replayed.
