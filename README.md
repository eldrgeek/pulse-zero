# Pulse Zero

The "needs-Mike action board." Four card types only: **ACTION**, **VERDICT**, **DECISION**, **BRIEF**. No wellness, digests, media, chat, alarms, or reader capture — see `../SOMA/pulse/STRIPPED-2026-07-15.md` for what got cut and why.

Static single-page app (`public/index.html`) + shared SOMA Auth Supabase project (`omfwcodoimjmbrhssvfl`), table `public.pulse_cards`. Magic-link login, allowlisted to `mw@mike-wolf.com`.

## Board standard (v2, 2026-07-26)

Mike monitors many concurrent AI sessions at once. A card exists because **one specific turn needs Mike's action** — privilege only he holds, real blast radius, a taste/consent call, or an external human is involved. Anything else is the poster's own job (see `~/Projects/SOMA/OWNERSHIP-DEFAULT.md`).

Every action card is: **one imperative line (≤60 chars) + a clickable link.** Never an essay. Put detail in `--steps`/`--why`, not the title. `pulse-push` enforces the length and warns (doesn't block) on a missing `--url` or a title that reads like a description/question instead of a command.

**Tower** (`~/Projects/_estate/specs/tower-steward-v0.md`) is the steward persona that gatekeeps the board. Cards that aren't genuinely Mike-gated get bounced with reason *"You know what to do, don't you?"* and land in the collapsed **Bounced (RSI)** section on the board — visible, not deleted, so the bounce rate feeds back into fleet norms (the RSI loop).

## Deploy

Netlify (`pulse-zero.netlify.app`), `publish = "public"`. No build step. Auto-deploys from `main` via the GitHub integration (`eldrgeek/pulse-zero`); `netlify deploy --prod` also works directly from this repo if you need it live before the webhook fires.

## Pushing cards (any AI session, any surface)

```bash
export PULSE_ZERO_SERVICE_KEY=<supabase secret key, sb_secret_...>   # never commit this
bin/pulse-push action   --title "Approve X" --why "..." --steps "1. ...\n2. ..." --url "https://..." --source dee --key "approve-x"
bin/pulse-push verdict  --artifact "Momentum v0" --url "https://momentum-demo-esr.netlify.app" --summary "..." --source dee --key "momentum-v0-verdict"
bin/pulse-push decision --question "Ship A or B?" --options "A,B,Other" --source dee --key "ship-a-or-b"
bin/pulse-push brief    --title "Estate brief 2026-07-16" --lines "Line1\nLine2\nLine3" --source dee --key "estate-brief-2026-07-16"
```

**Always pass `--key` for anything a session might push more than once** (a retry, a
recurring nightly job, a card re-pushed after a code change). `--key` is a stable dedup
slug: pushing again with the same key **updates the existing OPEN card in place** instead
of inserting a duplicate — same "replace same key" semantics as `_estate/bin/pulse-enqueue`.
Even without `--key`, `action` cards get a safety net: pushing an action with the same
`--title` (case-insensitive) and `--source` as an existing OPEN action card skips the
insert and warns on stderr instead of silently duplicating. (Bug found 2026-07-26: the
original `pulse-push` did a bare INSERT on every call with no dedup at all — multiple
sessions/Tower pushing near-identical cards produced real duplicates on the board.)

Optional Yeshie hand-off fields on `action` cards:

```bash
bin/pulse-push action --title "Renew the TLS cert" --url "https://dash.example.com" \
  --yeshie-steps $'1. Open dash\n2. Click Renew\n3. Confirm' \
  --yeshie-task 'sites/example.com/tasks/renew-cert.payload.json' \
  --source dee
```

- `--yeshie-steps` — newline-separated human steps. Renders as a **[Guide me]** overlay checklist on the card. No wiring dependency, always works. Pass plain phrases, not pre-numbered lines — the overlay renders an `<ol>` and numbers them itself (`1. 1. Click...` is a double-number if your steps text already starts with `1.`).
- `--yeshie-task` — inline JSON or a path to a Yeshie recipe/payload file. Renders a **[Yeshie: do it — I'll watch]** button, but only when the board is loaded with `?yeshie=1` (see Yeshie wiring status below).

Board contract enforcement: `--title` is required, imperative, and rejected (exit 1) over 60 chars. `--url` is not required but you'll get a warning without one.

### Tower subcommands

```bash
bin/pulse-push bounce  --id <card-id> --reason "Not Mike-gated — poster's own job"
bin/pulse-push resolve --id <card-id> --note "Mike's answer delivered out-of-band"
bin/pulse-push --list-bounced
```

`bounce` sets `status=bounced` + `bounce_reason`; the card moves to the board's collapsed "Bounced (RSI)" section. `resolve` sets `status=resolved` + `resolved_note` for closing a card administratively (not through the UI answer flow).

List/poll:

```bash
bin/pulse-push --list-open
bin/pulse-push --list-answers            # also mirrors newly-answered cards into SOMA/board/inbox/
bin/pulse-push --list-bounced
```

`PULSE_ZERO_SUPABASE_URL` defaults to the shared SOMA Auth project; override only if migrating.

## Board UI (public/index.html)

Action cards render as one line (title) + a button row:

- **Open** — deep link, `target=_blank`.
- **Preview** — toggles an inline sandboxed `<iframe>` of the card's `--url`. Best-effort detection of embed refusal (X-Frame-Options / `frame-ancestors`): if the frame doesn't fire `load` within ~2.5s, or fires implausibly fast (aborted-to-`about:blank`), shows *"Site refuses embedding — Open instead."* This is a heuristic, not a guarantee — some slow-loading real pages will false-positive; the Open link is always offered as the fallback.
- **Guide me** — only if the card has `yeshie_steps`; shows them as an overlay checklist.
- **Yeshie: do it — I'll watch** — only if the card has `yeshie_task` AND the board URL has `?yeshie=1`. See wiring status below.
- **Done** — marks answered (existing flow).
- **Not mine** — Mike bounces his own card (`status=bounced`, `bounce_reason="Not mine (Mike)"`); shows up in Tower's Bounced (RSI) section.

VERDICT/DECISION/BRIEF cards are unchanged. SOMA Auth magic-link allowlist is unchanged.

## Yeshie wiring status (2026-07-26, confirmed live)

The relay's `POST http://localhost:3333/run` endpoint (body `{payload, params?, tabId?, timeoutMs?}`) is real and has open CORS (`Access-Control-Allow-Origin: *`, no auth check in the current handler — see `~/Projects/yeshie/packages/relay/index.js` around line 1657). The board's "Yeshie: do it" button calls it directly.

**Tested live via CDP against the deployed HTTPS origin, same Mac as the relay** (Dee, 2026-07-26): the direct fetch **does not work, even on Mike's own Mac** — it neither resolves nor rejects, it just hangs. This is Chrome's Private Network Access check silently stalling a fetch from a public HTTPS page to a `localhost` target; a bare try/catch never fires because there's no error, just no response. First implementation missed this and left the button stuck on "Running…" forever — fixed by racing the fetch against a 4s client-side timeout (`timeoutAfter()` in `public/index.html`), confirmed by a second CDP pass: click → 4s → fallback overlay renders with the clipboard-copy instructions, button re-enables.

**What's wired and verified:** the attempt-then-fallback behavior. Every click either runs the task (if PNA ever allows it — untested combination, e.g. Chrome flag or a future browser policy) or falls back to clipboard-copy with manual run instructions inside 4 seconds, never hangs.

**What's still open / TODO:**
- The direct-trigger path is **not currently reachable from any browser context tested** — treat the button as "clipboard hand-off with a wired but presently-inert fast path," not a real one-click trigger. If PNA policy changes (or the relay adds a proper PNA preflight response, `Access-Control-Allow-Private-Network: true`) the fast path could start working without a code change; worth re-testing after any relay update.
- The relay's `/run` payload shape assumes a Yeshie `skill_run` chain (`payload` = a recipe/payload.json content). `--yeshie-task` accepting a bare path string wraps it as `{recipe_path: ...}`, which the relay does **not** currently know how to resolve from a path — only inline recipe JSON is actually runnable today (irrelevant while PNA blocks the transport anyway, but blocks it further even if PNA gets fixed).
- Feature-flagged behind `?yeshie=1` on purpose — the button is a known-not-yet-useful convenience until one of the above is resolved.

## Feedback (SOMA-APP-STANDARD §8)

Pulse Zero ships the canonical `soma-feedback` widget, vendored at
`public/vendor/soma-feedback/{soma-feedback.js,soma-feedback.css}`. Per §15's "app with its
own auth" adoption path, it does **not** route through the shared VPS `feedback-svc`
(that service has had real outages — an expired TLS cert took down every site's chip at
once on 2026-07-22). Instead `data-endpoint="/.netlify/functions/feedback"` points at
Pulse Zero's own Netlify function (`netlify/functions/feedback.js`), which writes into
Pulse Zero's own `public.pulse_zero_feedback` table (same Supabase project, own table).

**What's complete:** submissions land in `pulse_zero_feedback` (status `new`), honeypot
handled, CORS handled, `data-no-google` set (this origin isn't registered on the shared
Google OAuth client).

**What's stubbed, honestly:** no clarity-loop backend (every submission is accepted
immediately, no `clarify` round-trip) and no admin review UI yet — "all feedback → review
queue" per the standard's explicit fallback for when a full admin fast-path isn't built
yet. To see submitted feedback today, query the table directly:
`PULSE_ZERO_SERVICE_KEY=... curl "$PULSE_ZERO_SUPABASE_URL/rest/v1/pulse_zero_feedback?select=*&order=created_at.desc" -H "apikey: $PULSE_ZERO_SERVICE_KEY" -H "Authorization: Bearer $PULSE_ZERO_SERVICE_KEY"`.
A small admin view surfacing this list on the board is a reasonable next pass, not done here.

## Schema

`public.pulse_cards(id, app_id, type, payload jsonb, status, answer jsonb, created_by, created_at, answered_at, bounce_reason text, resolved_note text, yeshie_steps text, yeshie_task jsonb, dedupe_key text)`. `status` check constraint: `open | answered | retired | bounced | resolved`. RLS: service_role full access; `mw@mike-wolf.com` can select/update its own app_id rows. Migration SQL is not checked in (ad hoc via Supabase Management API) — see git history / session transcript if it needs to be replayed. 2026-07-26 ALTERs (additive, non-destructive): added `bounce_reason`, `resolved_note`, `yeshie_steps`, `yeshie_task` columns; widened the `status` check constraint to include `bounced` and `resolved`. 2026-07-26 (bugfix pass, later same day): added `dedupe_key text` + a partial index `(app_id, dedupe_key) where status='open' and dedupe_key is not null`; also added a new standalone table `public.pulse_zero_feedback(id, site, page, url, area, text, name, email, conversation jsonb, status, created_at)` for the §8 feedback widget (RLS: service_role full access, `mw@mike-wolf.com` select-only).

## Automated smoke test

`bin/test-board.sh` drives the deployed board end-to-end via Chrome CDP (same technique
used for manual verification): logs in with a real magic-link session, pushes test cards
(including a same-title/source pair to exercise dedup, a `decision` card to check the
Other-dialog contrast, and a pre-`resolved` card to check it's hidden by default), loads
the board, asserts the five bug fixes below didn't regress, then deletes every test row it
created. Run it with:

```bash
export PULSE_ZERO_SERVICE_KEY=<supabase secret key>
bin/test-board.sh
```

Run this before any future change to `public/index.html` or `bin/pulse-push` ships. It
requires Chrome running with remote debugging on port 9222 (`chrome-debug-launcher.sh` —
see `~/Projects/CLAUDE.md` "Only debug Chrome ever runs") and Python 3 with no extra
dependencies (uses the CDP HTTP/WebSocket endpoints directly, no Playwright install).
