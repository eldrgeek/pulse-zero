# Pulse Zero

The "needs-Mike action board." Four card types only: **ACTION**, **VERDICT**, **DECISION**, **BRIEF**. No wellness, digests, media, chat, alarms, or reader capture — see `../SOMA/pulse/STRIPPED-2026-07-15.md` for what got cut and why.

_Updated 2026-07-27: Mike Wolf defined the executable-human-gate doctrine;
OpenAI Codex implemented and documented typed, resumable, verified actions._

Static single-page app (`public/index.html`) + shared SOMA Auth Supabase project (`omfwcodoimjmbrhssvfl`), table `public.pulse_cards`.

## Sign-in (2026-07-27)

**"Continue with Google" is the primary path**; magic link is still there as the fallback. One click, no email round trip, and the Supabase session persists and auto-refreshes — so on a browser Mike already uses this should be a once-ever click.

The gate is a single function, `public.is_pulse_owner()`, listing **both** of Mike's identities:

- `mw@mike-wolf.com` — the magic-link address
- `mw.personalmail@gmail.com` — the account Google actually hands back (Google under-serves his legacy Workspace account, so the personal Gmail is the one he stays signed into)

Every RLS policy on `pulse_cards`, `pulse_card_comments`, and `pulse_zero_feedback` calls that function, and `netlify/functions/pulse-agent-session.js` mirrors the list. **To add or change an owner identity, edit the function — not six policies.**

Google here is the **redirect flow through Supabase's own `/auth/v1/callback`**, using the shared SOMA Auth Google client (`595993744223-…`). That client needs **no** per-origin registration, so nothing in the Google console is required — only that the origin sits in the Supabase `uri_allow_list`, which `pulse-zero.netlify.app` already does. (Don't confuse this with the soma-feedback chip's GIS One Tap client `1072944905499-…`, which *does* need Authorized JavaScript origins — that's why the chip on this page carries `data-no-google`.)

Signing in with an account that isn't on the list now renders an explicit "signed in as X, which isn't on this board" screen with a sign-out button. Before, RLS returned zero rows and the board rendered silently empty, which read as "Pulse is broken."

## Board standard (v2, 2026-07-26)

Mike monitors many concurrent AI sessions at once. A card exists because **one specific turn needs Mike's action** — privilege only he holds, real blast radius, a taste/consent call, or an external human is involved. Anything else is the poster's own job (see `~/Projects/SOMA/OWNERSHIP-DEFAULT.md`).

Every action card starts with **one imperative line (≤60 chars)**. Never an
essay; put context in `--why` and non-actionable orientation in `--steps`.
A single static review destination may use `--url`. Any operation Mike is
being asked to perform must instead be a typed `payload.actions` v1 button:
workflow/web routes to Yeshie, Mac work routes to Mac automation, and an
irreducible approval is represented as a web/workflow `human_gate` on the
exact target control. Prose-only requests are invalid authoring—Mike should
never have to translate a sentence into a hidden command. Completion comes
from a verified executor receipt, not a manually checked instruction.

`pulse-push` enforces the title length and typed-action shape. Links and
`--step-actions` remain for single static destinations and legacy-card
compatibility, not as the default executable handoff.

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

Legacy Yeshie hand-off fields on `action` cards:

```bash
bin/pulse-push action --title "Renew the TLS cert" --url "https://dash.example.com" \
  --yeshie-steps $'1. Open dash\n2. Click Renew\n3. Confirm' \
  --yeshie-task 'sites/example.com/tasks/renew-cert.payload.json' \
  --source dee
```

- `--yeshie-steps` — newline-separated human steps. Renders as a **[Guide me]** overlay checklist on the card. No wiring dependency, always works. Pass plain phrases, not pre-numbered lines — the overlay renders an `<ol>` and numbers them itself (`1. 1. Click...` is a double-number if your steps text already starts with `1.`).
- `--yeshie-task` — inline JSON or a path to a Yeshie recipe/payload file. Renders a **[Yeshie: do it — I'll watch]** button, but only when the board is loaded with `?yeshie=1` (see Yeshie wiring status below).

### Typed card actions (`payload.actions` v1)

Use `--actions` for every new card that asks Mike to do more than open the
card's one deep link. The value may be inline JSON or a path to a JSON file.
Every Mike-requested operation must be an action; prose in `--steps` is
context, not an invisible request.

```json
[
  {
    "id": "gdoc-auth",
    "revision": 1,
    "executor": "workflow",
    "label": "Authorize Google Docs",
    "description": "Connect the Estate Google Docs bridge to Mike's account.",
    "operation": "gdoc_bridge_authorize",
    "params": {
      "project_id": "gdoc-bridge-mw",
      "account": "mw@mike-wolf.com"
    },
    "human_gate": {
      "instruction": "On the Mac, click Continue to approve Google Drive access.",
      "target": {
        "url": "https://accounts.google.com/o/oauth2/v2/auth",
        "ref": "google.oauth.consent.primary",
        "label": "Continue"
      }
    },
    "completion": {
      "mode": "verified",
      "success_message": "Google Docs is connected.",
      "close_card": true
    },
    "verification": {
      "kind": "google_drive_about",
      "params": {}
    }
  }
]
```

The contract is deliberately family-agnostic:

- `executor: "web"` and `"workflow"` route through the durable Mac-command
  queue to Yeshie. Public Pulse HTTPS never calls `localhost`.
- `executor: "mac"` routes through the same queue to allowlisted Mac
  automation/mac-controller operations.
- `human_gate` is allowed only on web/workflow actions. Yeshie must navigate
  to and highlight `target.ref`, then observe Mike's click on that exact web
  control. Pulse cannot substitute an approval/consent click.
- All actions enqueue `command: "execute_card_action"` with the full typed
  action plus `card_id`, `action_id`, `revision`, and an idempotency key.
- `params`, verification metadata, and human-gate targets are persisted on the
  card/command and therefore must contain references and non-secret metadata
  only. Credentials remain on the Mac clipboard and are consumed by an
  allowlisted Mac operation; never put a credential value in `--actions`.
- `mac_commands` is the transport **and** durable receipt. Reloading Pulse
  resumes the current row. A failed retry increments `attempt`; duplicate
  clicks for the same attempt recover the existing row.
- A row is complete only when it is `status=done` **and**
  `result.verified=true`. `result.state=waiting_human` is surfaced while the
  database row remains open. The UI displays only `safe_message`, never raw
  executor output.
- Set `completion.close_card=true` on the terminal action when the card should
  auto-resolve after every typed action has a verified receipt. Otherwise the
  normal Done button appears only after all actions verify.
- `id + revision` is immutable. Changing an existing action requires
  incrementing `revision`; `pulse-push` rejects a same-revision behavior
  change so an old receipt cannot certify new behavior.

Production has
`supabase/migrations/20260727_typed_card_actions.sql` applied. New/local
environments must apply it before typed actions can run; it adds only
action-run metadata and a unique idempotency index to the existing
`mac_commands` table.
The current broker allowlist contains exactly
`workflow/gdoc_bridge_authorize`; additional executor/operation pairs must be
implemented and allowlisted in `pulse-mac-bridge` before a card may author
them. Unknown pairs fail closed.

`--step-actions` remains as a compatibility format for already-issued cards.
Its JSON array is index-aligned with `--steps`; each entry is `null` or an
object with `command`, `payload`, and optional `label` / `success_message`.
`open_url` renders as a native `<a target="_blank" rel="noopener">` link.
Other legacy commands go through the authenticated Mac bridge. New card
authors should use `--actions`; the CLI rejects mixing both contracts.

Board contract enforcement: `--title` is required, imperative, and rejected
(exit 1) over 60 chars. A card without `--url`, typed `--actions`, or a
legacy step link gets an authoring warning.

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
bin/pulse-push --list-answers            # also mirrors newly-answered cards (+ their comments) into SOMA/board/inbox/
bin/pulse-push --list-bounced
bin/pulse-push --list-snoozed            # cards hidden from the default view until snoozed_until passes
```

`PULSE_ZERO_SUPABASE_URL` defaults to the shared SOMA Auth project; override only if migrating.

### Snooze (2026-07-26)

Mike can defer a card ("push it off to later") without resolving or bouncing it. It stays `status='open'` the whole time — snooze is a visibility window (`pulse_cards.snoozed_until timestamptz`), not a status — so the board's answer/bounce/resolve flows are untouched. A snoozed card disappears from the default view and reappears automatically once `snoozed_until` passes, or immediately if Mike taps "Un-snooze now" in the collapsed **Snoozed — N** section (always present when anything is snoozed — nothing vanishes silently).

**Re-pushing a snoozed card is snooze-aware.** If a session re-pushes the same `--key` while the card is still snoozed:
- **Same payload/yeshie fields as what's already on the card** → the push is a no-op retry; it stays snoozed. Printed: `card <id> is snoozed until <ts>; re-push carried no new information — leaving it snoozed`.
- **Different payload/yeshie fields** → treated as genuinely new information; `snoozed_until` is cleared so Mike sees it now. Printed: `card <id> had new information on re-push — woke it from snooze`.

This means a recurring nightly job that pushes an unchanged card won't un-snooze it, but a job that pushes a materially updated card will.

### Comments (2026-07-26)

Mike can comment on any card from the board UI (a **Comments (N)** / **Add a comment** disclosure on every card, open or done) without changing its status — commenting is purely additive (table `public.pulse_card_comments`, FK'd to `pulse_cards.id`, own RLS, own realtime publication entry). The board fetches comments embedded via PostgREST's FK-based join (`pulse_cards?select=*,pulse_card_comments(*)`), so there's no extra round trip.

**Session-facing return path — extends the existing `--list-answers` / `sync_answers_to_board` mirror rather than inventing a parallel one.** Two ways to collect comments on cards you pushed:

```bash
# Targeted: only cards from your --source that have at least one comment, comments embedded.
bin/pulse-push --list-comments --source "ccd:<your session title>"

# Broad: the existing answered-card mirror into SOMA/board/inbox/, extended so it
# also (a) includes an open card if it has new comments (comments don't require a
# status change to be worth syncing) and (b) always rewrites the file (not just on
# first sync) so a comment added after a card was already answered/synced still shows up.
bin/pulse-push --list-answers
cat ~/Projects/SOMA/board/inbox/pulse-zero-<card-id>.json   # now includes a "comments" array
```

Sessions can also post their own comment (e.g. an acknowledgment) via `bin/pulse-push comment --id <card-id> --body "..." [--author <name>]` — `--author` defaults to `mike` since that's the normal path (the board UI), but any session can attribute its own.

## Board UI (public/index.html)

Action cards render as one line (title) + a button row:

- **Open** — deep link, `target=_blank`.
- **Preview** — toggles an inline sandboxed `<iframe>` of the card's `--url`. Best-effort detection of embed refusal (X-Frame-Options / `frame-ancestors`): if the frame doesn't fire `load` within ~2.5s, or fires implausibly fast (aborted-to-`about:blank`), shows *"Site refuses embedding — Open instead."* This is a heuristic, not a guarantee — some slow-loading real pages will false-positive; the Open link is always offered as the fallback.
- **Guide me** — only if the card has `yeshie_steps`; shows them as an overlay checklist.
- **Yeshie: do it — I'll watch** — only if the card has `yeshie_task` AND the board URL has `?yeshie=1`. See wiring status below.
- **Done** — marks answered (existing flow).
- **Not mine** — Mike bounces his own card (`status=bounced`, `bounce_reason="Not mine (Mike)"`); shows up in Tower's Bounced (RSI) section.
- **Snooze** — every card type (action/verdict/decision/brief) has this. Opens a preset picker (Tonight / Tomorrow morning / Next week, computed client-side in Mike's local time); the card leaves the default view until then. See "Snooze" under Pushing cards above for the CLI-side dedup interaction.

Typed actions render in an always-visible **Actions** panel; Mike never has
to infer an operation from prose. Buttons expose queued, running,
waiting-on-Mac, failed/retry, and verified states. Pending runs are resumed
from `mac_commands` after refresh, verified actions render as disabled
**Done**, and a typed card cannot be manually marked Done until all its
actions have verified receipts.

Legacy checklist rows may still carry a compact step-action button. Labels
describe the actual outcome (`Open Gemini API Keys`, `Install & verify`)
rather than the transport. Credential cards must say that secrets stay on
the Mac clipboard and must never be pasted into Pulse chat.

`renderApp()` may run more than once during Supabase's initial auth event.
The realtime channel is therefore created once and explicitly removed on
sign-out/wrong-account routing; reusing an already-subscribed channel and
adding callbacks again throws in current supabase-js.

Every card (including answered/bounced/done ones) has a task-scoped **Pulse
thread** at the bottom — see "Comments" above. Open action cards also show an
**Ask Pulse** button that expands and focuses the same thread. The input warns
not to paste credentials; replies retain their actual worker attribution.
The browser also refuses obvious Google API keys, 16-character App Passwords,
and common provider-key prefixes before a comment reaches the database.
Commenting never changes status.

VERDICT/DECISION/BRIEF cards are otherwise unchanged. SOMA Auth magic-link allowlist is unchanged.

### Pulse voice authentication

The voice bar is hidden until the existing Supabase magic-link session is
confirmed. It no longer connects to ElevenLabs with a public agent ID. The
browser sends its Supabase access token to
`/.netlify/functions/pulse-agent-session`; that function verifies the token
with Supabase, requires `mw@mike-wolf.com`, and uses the server-only
`ELEVENLABS_API_KEY` to return a short-lived ElevenLabs signed WebSocket URL.
The ElevenLabs agent must have `platform_settings.auth.enable_auth=true`.
Sign-out immediately ends any live conversation.

The Netlify production environment therefore requires
`ELEVENLABS_API_KEY`. Never expose this value in `public/` or return it from a
function.

## Yeshie wiring status (2026-07-26, confirmed live)

The typed-action transport is now
`Pulse → mac_commands:execute_card_action → pulse-mac-bridge → Yeshie`.
It does not depend on a public HTTPS page reaching localhost and it does not
offer clipboard/terminal handoff as the normal recovery path. The remainder
of this section documents the older feature-flagged `yeshie_task` button,
which stays only for compatibility while existing cards age out.

The current Google Docs authorization action completes immediately when its
read-only Drive probe already passes. If Google consent is genuinely needed,
the broker starts the local OAuth callback, opens the exact consent URL,
resolves `human_gate.target.ref` through its reviewed target allowlist, and
calls Yeshie's protected `POST /teach/start` highlight/observe endpoint.
Yeshie navigates and points; it never supplies the consent click. After Mike
clicks the highlighted control, the same durable action row resumes and the
executor verifies the resulting Drive access before Pulse can close the card.

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

`public.pulse_cards(id, app_id, type, payload jsonb, status, answer jsonb, created_by, created_at, answered_at, bounce_reason text, resolved_note text, yeshie_steps text, yeshie_task jsonb, dedupe_key text, snoozed_until timestamptz)`. `status` check constraint: `open | answered | retired | bounced | resolved`. RLS: service_role full access; `mw@mike-wolf.com` can select/update its own app_id rows. Migration SQL is not checked in (ad hoc via Supabase Management API) — see git history / session transcript if it needs to be replayed. 2026-07-26 ALTERs (additive, non-destructive): added `bounce_reason`, `resolved_note`, `yeshie_steps`, `yeshie_task` columns; widened the `status` check constraint to include `bounced` and `resolved`. 2026-07-26 (bugfix pass, later same day): added `dedupe_key text` + a partial index `(app_id, dedupe_key) where status='open' and dedupe_key is not null`; also added a new standalone table `public.pulse_zero_feedback(id, site, page, url, area, text, name, email, conversation jsonb, status, created_at)` for the §8 feedback widget (RLS: service_role full access, `mw@mike-wolf.com` select-only).

**2026-07-26 (snooze + comments pass):** added `pulse_cards.snoozed_until timestamptz` (nullable, additive). Added new table `public.pulse_card_comments(id uuid pk, card_id uuid references pulse_cards(id) on delete cascade, author text default 'mike', body text not null, created_at timestamptz default now())`, RLS mirrors `pulse_cards` (service_role full access; `mw@mike-wolf.com` select/insert), added to the `supabase_realtime` publication, indexed on `card_id`. This time the migration **is** checked in: `supabase/migrations/20260726_snooze_and_comments.sql` (still applied ad hoc via the Management API, not via `supabase db push` — the file exists purely so the change is reproducible/reviewable).

**2026-07-27 (typed actions):**
`supabase/migrations/20260727_typed_card_actions.sql` adds nullable
`pulse_card_id`, `pulse_action_id`, `pulse_revision`, `attempt`, and
`idempotency_key` metadata to `public.mac_commands`, plus a partial unique
index on non-null idempotency keys and a card/action lookup index. Legacy
command rows remain valid.

## Automated smoke test

`bin/test-board.sh` drives the deployed board end-to-end via Chrome CDP (same technique
used for manual verification): logs in with a real magic-link session, pushes test cards
(including a same-title/source pair to exercise dedup, a `decision` card to check the
Other-dialog contrast, a pre-`resolved` card, and 101 terminal-history rows), loads
the board, checks active-card visibility, task-scoped Ask Pulse, the authenticated
signed-session broker, contrast, history disclosure, dedup, and feedback, then deletes
every test row it created. Run it with:

```bash
export PULSE_ZERO_SERVICE_KEY=<supabase secret key>
bin/test-board.sh
```

Run this before any future change to `public/index.html` or `bin/pulse-push` ships. It
requires Chrome running with remote debugging on port 9222 (`chrome-debug-launcher.sh` —
see `~/Projects/CLAUDE.md` "Only debug Chrome ever runs") and Python 3 with no extra
dependencies (uses the CDP HTTP/WebSocket endpoints directly, no Playwright install).
The signed-session function also has focused fail-closed tests:

```bash
node --test test/*.test.js
python3 test/test_pulse_push_actions.py
```
