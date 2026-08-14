# Pulse Zero — CODE lane adversarial review

Reviewer: Dee (Sonnet 5, CCc), 2026-08-14. Scope: `pulse-zero/public/index.html`,
`pulse-zero/public/pulse-actions.js`, `pulse-zero/public/pulse-queue.js`,
`pulse-zero/bin/*`, `_estate/bin/pulse-*`, `_estate/bin/pulse_common.py`,
live Supabase schema (project `omfwcodoimjmbrhssvfl`, read-only via Management
API). **No files were edited.** This is a findings-only pass — the COO runs
the fix wave.



**FIX-WAVE STATUS (2026-08-14, Dee/Sonnet 5, CCc):** all 15 findings addressed — 13 FIXED, 1 FIXED-with-a-partial-WONT-FIX (#10's DB constraint half), 1 ANNOTATED (#14, comment corrected rather than building a new reopen feature). Deployed to `pulse-zero.netlify.app` + the live Supabase schema (verified via direct re-query on every DB-level claim). Per-finding status inline above.

Live schema was queried directly (`information_schema`, `pg_policies`,
`pg_constraint`, `pg_class`, `pg_proc`) rather than inferred from migration
files, because the two have drifted (see #5). Every "confirmed" claim below
was checked against the running database, not just the SQL in the repo.

---

## Severity counts

- **BLOCKS-MIKE: 4** (#1, #3, #4, #6)
- **CORRECTNESS: 7** (#2, #5, #7, #8, #9, #10, #13)
- **HYGIENE: 4** (#11, #12, #14, #15)

**Total: 15 numbered findings.**

---

## 1. [BLOCKS-MIKE] `pulse-answer-write` renders every verdict card's title as literal `"?"`

> **FIXED** — both call sites in `_estate/bin/pulse-answer-write` (line 97 list path, line 148 confirm-print path) now read `p.get("artifact_name")` instead of `p.get("artifact")`. Live-verified: `pulse-answer-write --list` correctly shows a real open verdict card's title (automated regression check in `bin/test-board.py`).

**File:** `_estate/bin/pulse-answer-write:97` and `:148`

```python
title = p.get("title") or p.get("question") or p.get("artifact") or "?"
```

The board payload field for a verdict card is `artifact_name` (set by
`pulse_common.queue_item_payload()` / `pulse-push verdict --artifact`), never
`artifact`. Verified against the live contract (`pulse_card_contract.py:89`:
`"verdict": ("artifact_name", "url", "summary")`) and against
`public/index.html:360-363`'s `cardTitleText()`, which correctly checks
`p.title || p.artifact_name || p.question`.

**Failure scenario:** any open verdict card (`pulse-answer-write --list`) or
any card just answered via `pulse-answer-write <key> --answer ... --resolve`
prints `[verdict]  ?  key=...` / `confirmed: [verdict] ? -> resolved`. This is
the exact "verdict cards render title '?'" bug named in the task brief — it's
a one-word typo (`artifact` vs `artifact_name`), reproduced twice in the same
file (list path and confirm-print path), and it silently degrades a
telemetry/attribution tool (this is literally the tool that fixes the
"created_by unknown" attribution problem) into logging unreadable rows for
one whole card type.

**Smallest fix:** `p.get("artifact")` → `p.get("artifact_name")` at both
lines 97 and 148.

---

## 2. [CORRECTNESS] `dedupe_key` has no uniqueness constraint — "replace in place" is a UI-layer convention only, not a DB guarantee

> **FIXED** — `create unique index pulse_cards_open_dedupe_key_idx on public.pulse_cards (dedupe_key) where status = 'open' and dedupe_key is not null;` applied live via the Management API (verified via `pg_indexes` re-query). The exact SQL prescribed. A raw duplicate-key INSERT while an open row with that key exists now returns HTTP 409 (verified live, automated regression check in `bin/test-board.py`).

**File:** live schema (`pg_constraint` on `public.pulse_cards`) +
`_estate/bin/pulse_common.py:396-443` (`push_card`) +
`pulse-zero/bin/pulse-push:558-612` (dedup path 1)

Confirmed via `pg_constraint`: `pulse_cards` has exactly a primary key on
`id` and two CHECK constraints (`status`, `type`) — **no unique index or
constraint on `dedupe_key`, at all.** "Replace same key" is implemented
entirely in application code, and the two writers implement it
*differently*:

- `pulse-push`'s `push()` (index.html's peer CLI) looks up
  `status=eq.open AND dedupe_key=eq.<key>` before deciding INSERT vs PATCH
  (`pulse-push:558-564`) — but this lookup is **scoped to `status=eq.open`**.
- `pulse_common.push_card()` (used by `pulse-morning` and `pulse-drain`) does
  **no lookup at all** — it is a bare `POST` (`pulse_common.py:442`,
  `sb("POST", "pulse_cards", ...)`), regardless of whether a row with that
  `dedupe_key` already exists in any status.

**Failure scenario:** any re-push of a `--key` whose existing card is no
longer `open` (answered, resolved, bounced, or already-retired-and-being-
escalated) inserts a **second row carrying the same `dedupe_key`** instead of
erroring or updating. This is not hypothetical — it is `pulse-drain`'s
designed behavior (see #3) and it also means `pulse-answer-write`'s
`find_card()` (`pulse-answer-write:65-74`, `status=eq.open&dedupe_key=eq.X`)
can legitimately return **two** open rows for one key and hard-`sys.exit`
with "multiple open card(s) match" — refusing to record Mike's answer at all
until a human manually resolves the duplicate.

**Smallest fix:** add `create unique index pulse_cards_open_dedupe_key_idx on
public.pulse_cards (dedupe_key) where status = 'open' and dedupe_key is not
null;` (a partial unique index — multiple *terminal*-status rows may
legitimately share a key across history, but never two *open* rows), and let
the INSERT paths surface the resulting `23505` as a real error instead of
silently creating a duplicate.

---

## 3. [BLOCKS-MIKE] `pulse-drain`'s snapshot-then-write escalation can silently destroy Mike's just-recorded answer — this is the "dedupe_key reopening answered cards" mechanism

> **FIXED** — `pulse_common.archive_card`'s PATCH is now conditional (`?id=eq.{id}&status=eq.open`) and returns `[]` (not raised) on a 0-row match; both `pulse-drain` call sites (retire loop and escalate loop) now check the result and log a skip ("card changed under us") instead of assuming success. This closes both the escalate-a-closed-ask and the answer-clobber failure modes with the one change the finding prescribed. Not independently re-tested against a live race (would require racing a real Mike answer against a live `pulse-drain --commit` run, which is out of scope for a fix-verification pass) — verified by code review + a direct DB-level test of the underlying conditional-PATCH mechanism (see CODE#2's regression check, same mechanism).

**File:** `_estate/bin/pulse-drain:117-181`, `_estate/bin/pulse_common.py:446-450` (`archive_card`)

`pulse-drain` reads a full snapshot of open cards once
(`cards = open_cards(url, key)` at line 117), classifies each, then **later**
(after however long the run takes — network round trips × N cards, plus the
`pulse-archive` subprocess call at line 115) writes against that stale
snapshot with **no re-check of the card's current status**:

```python
new = push_card(url, key, c["type"], p, "pulse-drain (escalator)", ...)   # INSERT, same dedupe_key
archive_card(url, key, c["id"], f"escalated to Day {day} → {new.get('id')}")  # PATCH, unconditional
```

`archive_card` (`pulse_common.py:449-450`) is an unconditional PATCH:

```python
return sb("PATCH", f"pulse_cards?id=eq.{card_id}", url, key,
          body={"status": "retired", "answer": reason, "answered_at": iso(now_utc())})
```

**Failure scenario:** Mike answers card X (a real decision/verdict, age
already past `--escalate-after`, e.g. 48h+ old) at any point between
`pulse-drain`'s snapshot read and the moment it processes X in its escalate
loop — plausible any time this runs while Mike is reviewing his board, since
nothing pauses or re-queries. Result:
1. A **duplicate "⏫ Day N — still waiting" card is pushed** for an ask Mike
   already closed (per #2, since the dedupe_key isn't unique, this succeeds
   silently rather than failing).
2. `archive_card`'s PATCH then **overwrites X's `answer` field** (which held
   Mike's real `{value, channel, by}` answer JSON) **with a plain string**
   (`"escalated to Day N → <new id>"`), and forces `status` from `answered`
   back to `retired`.

The net effect Mike sees: the ask he already answered reappears louder
("still waiting"), and the record of what he actually said is gone —
overwritten, not archived — with no way to recover it from the DB (no
audit/history table on `pulse_cards`). This is the precise mechanism behind
the class of bug flagged in the task brief as "an open question — settle it
by reading the code": it is not a `Prefer: resolution=merge-duplicates`
upsert (there isn't one anywhere in this codebase), it's a **stale-snapshot
race with no optimistic-concurrency guard**, on the one write path
(`archive_card`) that both destroys data and fires from an unattended nightly
cron.

**Smallest fix:** every write in `pulse-drain`'s retire/escalate loops should
be a conditional PATCH — `?id=eq.{id}&status=eq.open` — and treat "0 rows
returned" as "card changed under us, skip it, log it," never as success. This
closes both the escalate-a-closed-ask and the answer-clobber failure modes
with one change (PostgREST returns an empty array on a WHERE that matches
nothing; the existing `if not result: ...` idiom used elsewhere in this
codebase, e.g. `pulse-push:783`, already handles that shape).

---

## 4. [BLOCKS-MIKE] `mac_commands` RLS policy is hardcoded to the wrong identity — every step-action / legacy typed-action button is broken when Mike is signed in via Google

> **FIXED** — `alter policy mw_read_write on public.mac_commands using (public.is_pulse_owner()) with check (public.is_pulse_owner());` applied live (verified via `pg_policies` re-query: `qual`/`with_check` both now call `is_pulse_owner()`). `revoke all on public.mac_commands from anon;` also applied (verified via `information_schema.role_table_grants`: `anon` no longer appears). Not independently re-tested by actually signing in as `mw.personalmail@gmail.com` and clicking a step-action button (would require driving a real Google OAuth flow, out of scope for automated regression) — verified by direct policy-definition inspection, which is the actual mechanism the finding named.

**File:** live schema (`pg_policies` on `public.mac_commands`) vs.
`public/index.html:429-437` (`OWNER_EMAILS`) and `:696-698`, `:940-943`
(direct client INSERTs into `mac_commands`)

Confirmed via `pg_policies`:

```
mac_commands.mw_read_write (cmd=ALL):
  qual/with_check: (auth.jwt() ->> 'email') = 'mw@mike-wolf.com'
```

Compare `public.is_pulse_owner()` (used correctly by every `pulse_cards` and
`pulse_card_comments` policy):

```sql
select lower(coalesce(auth.jwt() ->> 'email', '')) in (
  'mw@mike-wolf.com', 'mw.personalmail@gmail.com'
);
```

`mac_commands` never calls `is_pulse_owner()` — it re-implements the check
inline, and only for one of the two owner emails. `index.html`'s own
`OWNER_EMAILS` comment (`:429-433`) states plainly that
`mw.personalmail@gmail.com` (Google OAuth) is "the one he actually stays
signed into" because his legacy Workspace account (`mw@mike-wolf.com`) gets
worse Google service.

**Failure scenario:** signed in via "Continue with Google" (the documented
common case), Mike taps any step-action button
(`runStepAction` → `sb.from('mac_commands').insert(...)`, index.html:696) or
triggers the legacy typed-action compatibility INSERT path
(`runTypedCardAction`, index.html:940, used whenever `c.queue_state !==
'queued'`, i.e. every typed-action card in production today per #5). Postgres
rejects the INSERT with "new row violates row-level security policy for
table mac_commands" — a real, loud Postgrest error, so it's not the silent-204
class, but it is a **hard failure on the primary action-execution surface of
the board**, for the identity the code itself documents as the one Mike
actually uses. `pollMacCommand`'s SELECT-side reads would separately come
back empty (RLS filters rows, not an error) if a row somehow existed under a
different session.

Secondary, lower-severity finding on the same table: `information_schema.
role_table_grants` shows `anon` holds full
`SELECT/INSERT/UPDATE/DELETE/TRUNCATE` on `mac_commands` (same grants as
`authenticated`). RLS (`relrowsecurity=true`) still gates actual access, so
this isn't independently exploitable today, but it's unnecessary
defense-in-depth erosion — the anon key is public in the client bundle
(`index.html:313`), and there's no reason the `anon` role needs write grants
on a Mac-command-execution table at all.

**Smallest fix:** `alter policy mw_read_write on public.mac_commands using
(public.is_pulse_owner()) with check (public.is_pulse_owner());` — one-line
parity fix with the other two tables. Consider also `revoke all on
public.mac_commands from anon;` while there.

---

## 5. [CORRECTNESS] The entire "queue v1" feature does not exist in the production database — migration authored, frontend shipped, never applied

> **FIXED, by removal** (Mike's explicit direction: "REMOVE the ~250 dead lines... removal is the honest state") — deleted `loadQueueCardsV1`/`renderQueueCard`/`queueCardTitle`/`queueExecutionLabel`/`loadContinuationRuns`/`pollContinuationRun`, the `QUEUE_V1_FLAG`/`?queue_v1=1` branches in `answerCard`/`runTypedCardAction`/`maybeResolveTypedActionCard`, all of `public/pulse-queue.js` (+ its two test files + fixture), `pulse-push`'s `--queue-v1` authoring path (`validate_queue_contract`/`apply_queue_authoring`/`add_queue_args`), and the dead queue-only CSS. `EXECUTABLE-QUEUE-PLAN-2026-08-01.md` marked RETIRED-UNBUILT with a pointer back to itself if the direction is ever revived. The migration file itself (`supabase/migrations/20260801_executable_queue_v1.sql`) was left in place, unapplied, as the historical design record. Verified: full JS (`node --test`, 27/27) and Python (`pytest`, 23/23) suites green after removal.

**File:** `supabase/migrations/20260801_executable_queue_v1.sql` (dated
2026-08-01) vs. live schema (verified via `information_schema.tables` and
`pg_proc`)

Live-queried directly against project `omfwcodoimjmbrhssvfl` (the same
project `SUPABASE_URL` in `index.html:312`):

- `select table_name from information_schema.tables where table_name in
  ('pulse_active_queue_v1','pulse_continuation_runs', ...)` → **neither
  exists.**
- `select proname from pg_proc where proname ilike '%pulse%'` → only
  `is_pulse_owner` exists. **`enqueue_pulse_action`, `answer_pulse_gate_v1`,
  `start_pulse_continuation_v1` do not exist.**
- `pulse_cards` has no `queue_state`, `gate_contract`, `continuation_contract`,
  `priority_band`, `priority_reason`, `deadline_at`, `mission_lane`,
  `contract_version`, or `queue_position` columns — the entire queue-authoring
  surface pulse-push's `apply_queue_authoring()` (`pulse-push:381-421`) writes
  to is absent.

**What this means concretely:**
- `loadQueueCardsV1()` (`index.html:1504-1536`), reached via `?queue_v1=1`,
  hard-fails on its first query (`sb.from('pulse_active_queue_v1')...`) and
  renders "Queue preview unavailable: relation \"public.pulse_active_queue_v1\"
  does not exist" — confirmed by reading the code path, not just the schema
  gap (the error branch at `:1512-1516` prints `queueResult.error.message`
  verbatim).
- `renderQueueCard`, `queueCardTitle`, `queueExecutionLabel`,
  `answerCard`'s `queue_state === 'queued'` branch (`:1481-1493`, calls
  `sb.rpc('answer_pulse_gate_v1', ...)`), `maybeResolveTypedActionCard`'s
  `c.queue_state === 'queued'` branch (`:885-905`, calls
  `sb.rpc('start_pulse_continuation_v1', ...)`), `loadContinuationRuns`, and
  `pollContinuationRun` are all **dead code against production** — reachable
  only by a URL flag that immediately errors, or by a `queue_state` value
  that no live row can ever carry.
- `pulse-push --queue-v1` (`pulse-push:819-830`, `381-421`) would itself hard
  `sys.exit` on first use — PostgREST would reject the PATCH/INSERT for an
  unknown column — so no producer has exercised this path in production, which
  is consistent with zero live rows carrying queue fields.

This is a deploy-discipline gap, not a logic bug in the SQL itself (the
migration file looks internally consistent) — but roughly 250 lines of
`index.html` (queue rendering + typed-action RPC paths) and all of
`pulse-queue.js` (294 lines) currently ship to every board load and do
nothing in production except add attack surface and confuse anyone reading
the file who assumes shipped-frontend implies shipped-backend.

**Smallest fix:** either apply the migration (`supabase db push` /
Management API against `omfwcodoimjmbrhssvfl`) if queue v1 is meant to be
live, or strip the dead branches and gate `?queue_v1=1` behind a build flag
until it is. Given `_estate/EXECUTABLE-QUEUE-PLAN-2026-08-01.md` exists and
`ESTATE.md`/`WORKQUEUE.md` reference queue-v1 mechanics as if operative, this
is worth flagging to whoever owns that plan — it reads like a stalled
migration step, not an abandoned feature.

---

## 6. [BLOCKS-MIKE] Unsanitized `href`/`window.open`/iframe `src` from worker-authored `payload.url` — `javascript:`/`data:` URI is a live stored-XSS path in Mike's authenticated session

> **FIXED** — `safeHttpUrl()` (already correct, already used for step-actions) now gates all four call sites named in this finding: verdict link, decision "Full writeup" link, action Open/Preview. Each site computes `safeUrl = safeHttpUrl(p.url)` once per render and uses it everywhere instead of raw `p.url`; the Open/Preview buttons don't render at all when it's `null` (matching the existing "Invalid link" fallback pattern). ALSO fixed at the contract layer (composing with the finding's own "skip rendering... when it returns null" suggestion, taken one layer further): `pulse_card_contract.py`'s new `validate_url_scheme()` refuses any non-http(s) `url` at insertion time, so a bad-scheme card can no longer even reach the board. Verified: 4 new unit tests in `test/test_card_contract_gate.py`, plus a live hostile-payload browser test (`bin/test-board.py`) confirming no `javascript:` href ever appears in the DOM.

**File:** `public/index.html:1343` (verdict link), `:1356` (decision "Full
writeup" link), `:1387-1388` (action "Open"/"Preview") vs.
`pulse_card_contract.py:123-131` (`REQUIRED_FIELD_TYPES = {"url": str, ...}`
— type-checked only, no scheme check)

`esc()` (`index.html:321`) only HTML-entity-escapes `&<>"'` — it does not
validate or block URI schemes. Three of the four places `payload.url` reaches
the DOM skip the one function in this file that *does* validate schemes
(`safeHttpUrl()`, `index.html:397-404`, `['https:','http:'].includes(...)`,
used correctly for step-action `open_url` buttons at `:614-618`):

```js
// verdict, :1343 — scheme unchecked
<a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>

// decision, :1356 — scheme unchecked
<a href="${esc(p.url)}" target="_blank" rel="noopener">Full writeup &rarr;</a>

// action, :1387-1388 — scheme unchecked
if (action === 'open') { window.open(p.url, '_blank', 'noopener'); return; }
if (action === 'preview') { togglePreview(div, p.url); return; }   // sets iframe.src = url
```

Server-side, `pulse_card_contract.py` requires `url` to be a **non-empty
string** and nothing else — `--url 'javascript:fetch(...).then(r=>...)'`
passes `validate_payload()` cleanly for action, verdict, and decision cards
alike (all three types accept `url` as a required-or-optional field per
`REQUIRED_FIELDS`/`OPTIONAL_FIELDS`, `pulse_card_contract.py:86-104`).

**Failure scenario:** any producer (an AI worker, a buggy script, a
compromised or careless dispatch prompt — the task brief explicitly flags
"cards carry worker-authored text") pushes a verdict/decision/action card
with `--url 'javascript:...'`. The card renders normally; the link/button
looks like a normal external link. One click by Mike executes arbitrary JS
in `pulse-zero.netlify.app`'s origin, inside his authenticated session
(`window.pulseSupabase` — the live Supabase client holding his session —
is attached to `window` at `index.html:318`, so a payload here can read/
exfiltrate his access token or act on the board as him). `togglePreview`'s
iframe (`:1104-1127`) is marginally safer (sandboxed, but `allow-scripts
allow-same-origin` together defeat most of the sandbox's isolation value for
a `javascript:`/`data:` src) but still unvalidated.

**Smallest fix:** route all four call sites through `safeHttpUrl()` (already
written, already correct, already used for step-actions) instead of raw
`p.url`; skip rendering the link/button entirely (same pattern as the
existing `Invalid link` fallback at `:618`) when it returns `null`.

---

## 7. [CORRECTNESS] Terminal-state PATCHes from the client carry no status guard — double-tap, cross-device, and drain-vs-answer races are all unprotected except on one path

> **FIXED** — `bounceByMike` and `answerCard`'s legacy PATCH both now append `.eq('status', 'open')` (mirroring the one write that already got this right) and check the returned row count via `.select()`; an empty return surfaces "this card already changed — reloading" instead of silent success. The clicked button (and its whole `.actions` row) is now disabled synchronously before the `await`, matching `runTypedCardAction`/`runStepAction`'s existing pattern. Closes failure scenarios A (double-tap) and C (answer-vs-drain, via CODE#3's matching server-side guard); scenario B (cross-device) is mitigated the same way — whichever PATCH lands first wins cleanly, the second gets the "already changed" surfaced instead of a silent overwrite.

**File:** `public/index.html:1137-1145` (`bounceByMike`), `:1478-1502`
(`answerCard`, legacy branch) vs. `:907-911`
(`maybeResolveTypedActionCard`, which *does* guard)

```js
// bounceByMike — no status filter
await sb.from('pulse_cards').update({ status: 'bounced', ... }).eq('id', c.id);

// answerCard, legacy path — no status filter
await sb.from('pulse_cards').update({ status: ..., answer, answered_at }).eq('id', id);

// contrast: the ONE guarded write in the file
await sb.from('pulse_cards').update({ status: 'resolved', ... })
  .eq('id', c.id).eq('status', 'open');   // :911
```

Neither the DB (only a value CHECK on `status`, no transition/state-machine
constraint — confirmed via `pg_constraint`) nor these two client call sites
enforce "only from `open`." `renderCard`'s buttons (`:1383-1408`) call
`answerCard`/`bounceByMike` directly with no `btn.disabled = true` guard
before the async call resolves, unlike `runTypedCardAction`
(`:920`, `btn.disabled = true` first line) and `runStepAction`
(`:683`, same).

**Failure scenario A (double-tap):** a fast double-click/double-tap on a
decision option before the first `answerCard` call's promise resolves and
`loadCards()` re-renders fires two PATCHes; last-write-wins on `answer` with
no error to either "click," so a fat-fingered second option can silently
overwrite the first with nothing in the UI indicating a change happened.

**Failure scenario B (cross-device):** Mike has the board open on phone and
laptop (a stated pattern — `reloadCardsPreservingScroll`'s comment at
`:1617-1624` explicitly describes concurrent-device use). Two different
answers to the same still-`open` card from two devices race the same way;
whichever PATCH lands last wins with no conflict surfaced.

**Failure scenario C (answer-vs-drain):** covered in depth by #3, but worth
naming here too — `bounceByMike`/`answerCard` are exactly as unguarded as
`pulse-drain`'s `archive_card`, so a Mike-vs-nightly-job race can go either
direction depending on timing, and neither side would know it lost.

**Smallest fix:** append `.eq('status', 'open')` to both PATCHes (mirroring
`:911`), check the returned row count, and surface "this card already
changed — reload" instead of the current silent success. Disable the
clicked button synchronously before the `await`, same pattern already used
by the two functions that get this right.

---

## 8. [CORRECTNESS] `pulse-realtime-watch.mjs`'s status-transition check is a no-op — `REPLICA IDENTITY` doesn't carry `old.status`

> **FIXED** — `alter table public.pulse_cards replica identity full;` applied live (verified via `pg_class.relreplident = 'f'`). `pulse-realtime-watch.mjs`'s existing `was !== is` comparison now does what its own comment already claimed — no code change was needed there once `p.old?.status` actually carries the prior value; the comparison was correct code waiting on a schema fix, not itself buggy.

**File:** `_estate/bin/pulse-realtime-watch.mjs:107-116` vs. live schema
(`pg_class.relreplident` for `pulse_cards`)

```js
.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pulse_cards' }, (p) => {
  const was = p.old?.status, is = p.new?.status;
  if (was !== is && ['answered', 'resolved'].includes(is)) { schedulePickup(...); }
})
```

`pulse_cards.relreplident` is `d` (`default` — primary key only), confirmed
live. Per Postgres logical-replication semantics, Supabase Realtime's `old`
record on an UPDATE payload only includes columns covered by the replica
identity — here, just `id` — **unless the table is `ALTER TABLE ... REPLICA
IDENTITY FULL`**. `p.old?.status` is therefore always `undefined`, so `was
!== is` is true on every single UPDATE where the new status happens to be
`answered`/`resolved` — including edits to a card that was *already*
`answered`/`resolved` (a step_state PATCH, a comment-loop payload fix-up via
`pulse-mac-bridge`, a re-push's PATCH body from `pulse-push`'s dedupe path,
etc. — none of these change `status` but all of them are UPDATEs, and if the
row's status happens to already read `answered`, `p.new?.status` still
reports `'answered'`, satisfying the condition every time).

**Current masking:** this doesn't yet produce a *visible* symptom because
`pulse-act`'s own idempotency key (`f"{c['id']}@{c.get('answered_at')}"`,
`pulse-act.py:149`, effectively) is unchanged by these spurious re-fires, so
`pulse-act --commit` correctly no-ops on the replay. But the code's own
comment ("status transitions are the decision events; payload-only edits are
not") states an intent the code does not implement — the daemon is
correctness-by-accident, coupled silently to a downstream idempotency guard
it doesn't know about. Any future change to `pulse-act`'s dedupe key (or a
new consumer of this same "on transition" signal that lacks that specific
guard) would double-act on stale cards.

**Smallest fix:** `alter table public.pulse_cards replica identity full;`
(cheap, low-row-count table) so `p.old` actually carries the prior `status`
and the existing comparison does what its comment says; or, cheaper still,
drop the `was !== is` pretense and debounce on "new.status is answered/
resolved," which is honestly what the code does today.

---

## 9. [CORRECTNESS] A realtime event on *any* card wipes an in-progress, unsent comment on the card Mike is actively typing into

> **FIXED** — `uiState.commentDrafts` (a `Map<cardId, string>`) is now written on every `input` event on `.comment-input` and restored in `wireComments()` after any re-render, cleared only on successful submit. Verified live: typed-but-unsent draft text on one card survives a full `loadCards()` rebuild triggered by an unrelated realtime event (automated regression check in `bin/test-board.py`, simulating the exact scenario the finding describes).

**File:** `public/index.html:1617-1642` (`reloadCardsPreservingScroll`,
`renderApp`'s subscription), `:409-425` (`uiState`), `:1269-1274`
(comment-input markup)

The realtime subscription (`:1636-1641`) fires `reloadCardsPreservingScroll`
on **every** `postgres_changes` event on `pulse_cards` *or*
`pulse_card_comments`, for **any** row — `{event: '*', ..., table:
'pulse_cards'}` has no per-row filter. `reloadCardsPreservingScroll`
(`:1625-1629`) calls `loadCards()`, which does `main.innerHTML = ''`
(`:1507`, `:1560`) and rebuilds every card's DOM from scratch.

`uiState` (`:409-425`) is explicitly designed to survive this rebuild for
open drills, pins, open comment *threads* (`openComments`), and a pending-
reply marker (`pendingComment`) — the file's own comments describe exactly
this problem being solved for those three things (`:406-408`,
`:1617-1624`). But there is **no field for the literal text currently typed
into `.comment-input`** before Send is clicked (`wireComments`,
`:1277-1295`, reads `input.value` only at submit time; nothing persists it
into `uiState` on `input`/`keyup`).

**Failure scenario:** Mike opens a comment thread on card A and starts
typing a reply. Meanwhile `pulse-promote` pushes a new card (event-driven,
"within 1s" per the README), or anyone posts a comment on unrelated card B,
or `pulse-act` PATCHes an unrelated card's status. Any of these fires the
realtime channel → full reload → card A's `.comment-input` is a fresh DOM
node with an empty value. Mike's partially-typed reply is gone, silently,
mid-keystroke, with no warning — on a board whose own measured numbers
(`SOMA/pulse/USEFULNESS-2026-08-11.md`, cited in `pulse-answer-write`'s
docstring) say 64% of his closes are exactly this kind of in-conversation
prose answer.

**Smallest fix:** on every `input` event, write `input.value` into a
`uiState.commentDrafts` `Map` keyed by card id; after `loadCards()` rebuilds
a card whose thread is open (`uiState.openComments.has(c.id)`), restore the
draft into the new `.comment-input` node in `wireComments`. Cheaper
short-term mitigation: debounce the realtime reload (e.g. 1.5–2s, matching
the debounce already used server-side in `pulse-realtime-watch.mjs`) so a
reload mid-keystroke is less likely, though that only narrows the window, it
doesn't close it.

---

## 10. [CORRECTNESS] `created_by` silently defaults to `'unknown'` with no board-visible marker

> **FIXED (board-visible signal only)** — `sourceUnknownBadge(c)` renders a small "source unknown" badge (same visual style as the escalation badge) whenever `c.created_by === 'unknown'`. **WONT-FIX (partial)** — the finding's second suggestion, a DB CHECK constraint forcing ask-cards to fail loudly rather than land unattributed, was not added: `pulse-push`'s own loud stderr warning already makes the omission visible in every producer's log at write time (the gap this finding is really about is the *board-visible* signal, which is now fixed), and a hard DB constraint risks turning a currently-recoverable soft failure into a hard 4xx for any caller that doesn't set `created_by` — judged a bigger, separately-reviewable change than this fix wave's scope.

**File:** live schema (`pulse_cards.created_by` `column_default =
'unknown'::text`), `pulse-zero/bin/pulse-push:519-531`

The DB column itself defaults to `'unknown'`, and `pulse-push` (`:526-531`)
falls back to the same string when neither `--source` nor `$PULSE_SOURCE` is
set — printing a `warn:` to **stderr only**. `_estate/bin/pulse_common.py`'s
`push_card()` has no equivalent fallback/warning at all — `created_by` is a
required positional argument there, so `pulse-morning`/`pulse-drain` can't
silently produce `'unknown'` cards, but any other direct caller of
`push_card()` could pass an empty string and get it.

**Failure scenario:** an unattributed card lands on Mike's board with
nothing in the rendered UI distinguishing it from a properly-sourced one —
`created_by` isn't rendered anywhere in `index.html`'s card view at all (it
only appears in the bounced-card reason line, `:1421`, and comment-thread
`created_by` filter for `pulse-push --list-comments`). Per the docstring's
own stated rationale ("unattributed cards strand Mike's answers — no poster
to notify"), this matters specifically for `pulse-act`'s answer-routing
(`build_prompt`, `pulse-act:90-120`) and the comment-answer loop
(`pulse_common.build_answer_prompt`) — both of which have no fallback
routing for `created_by == 'unknown'` beyond "there is nobody to tell."
This is consistent with the task brief's citation of `created_by "unknown"`
as a real shipped bug class from the last 72h — confirmed here that the gap
is silent all the way to the board (Mike has no way to see, from the card
itself, that it's unattributed) and not just a producer-side hygiene issue.

**Smallest fix:** render a small "source unknown" badge when `c.created_by
=== 'unknown'` (cheap, visible-to-Mike signal), and consider a DB CHECK
(`created_by <> 'unknown' or type = 'brief'`) forcing ask-cards to fail
loudly rather than land unattributed — briefs are lower-stakes since nobody
needs to "answer" one.

---

## 11. [HYGIENE] `cardTitleText()` / `queueCardTitle()` are near-duplicate functions, and the latter is dead code

> **FIXED, by removal** — `queueCardTitle` (the near-duplicate, dead half of this finding) was deleted along with the rest of CODE#5's dead queue-v1 code. `cardTitleText()` remains the one canonical title function, used everywhere.

**File:** `public/index.html:360-363` vs. `:1425-1428`

```js
function cardTitleText(c) {
  const p = (c || {}).payload || {};
  return stripEscalationBanner(p.title || p.artifact_name || p.question || '') || 'Untitled card';
}
function queueCardTitle(c) {
  const p = c.payload || {};
  return stripEscalationBanner(p.title || p.artifact_name || p.question) || 'Untitled gate';
}
```

Identical logic, different fallback string, `queueCardTitle` skips the
`|| ''` before `stripEscalationBanner` (harmless given `stripEscalationBanner`
already `String()`-coerces, but it's needless divergence). Per #5,
`queueCardTitle` is only reached from `renderQueueCard`, which is only
reached from `loadQueueCardsV1`, which errors out before ever calling it in
production. One canonical function, used everywhere, is the fix — no
functional risk either way since the code doesn't currently run.

---

## 12. [HYGIENE] `pulse-act`'s log-line title has the same missing-`artifact_name`-fallback bug as #1, lower stakes

> **FIXED** — `_estate/bin/pulse-act`'s log-line title derivation now includes the `artifact_name` fallback (`title = (_payload.get("title") or _payload.get("question") or _payload.get("artifact_name") or "")[:60]`), matching CODE#1's fix pattern.

**File:** `_estate/bin/pulse-act:150-151`

```python
title = ((c.get("payload") or {}).get("title")
         or (c.get("payload") or {}).get("question") or "")[:60]
```

No `artifact_name` fallback, so every verdict card's `act-on-answer` log line
(`_estate/pulse-act.log`) and dry-run stdout (`would dispatch act-on-answer
for {id} ('')`) shows an empty title instead of the verdict's name. Not
Mike-facing (this is a dispatcher's internal log/dry-run line, not a board
render), so HYGIENE rather than BLOCKS-MIKE, but it's the same bug pattern as
#1 and worth fixing in the same pass since it makes `pulse-act --commit`'s
own audit trail unreadable for one whole card type.

---

## 13. [HYGIENE / CORRECTNESS for the audit tool itself] `pulse-board-truth`'s title/gating logic never reads `artifact_name`

> **FIXED** — added a shared `card_title(card)` helper (title → artifact_name → question fallback) to `_estate/bin/pulse-board-truth`; `card_text()`'s `parts` list now includes `artifact_name`, and all three JSON-report title-derivation sites (`defects.open_action_cards_without_link_surface`, `defects.open_cards_suspect_not_mike_gated`, `open_cards`) now call the shared helper instead of a bare `.get("title")`. Verified: `--selftest` still passes (17/17 including the read-only-guarantee AST check), and a live `--stdout` run against the real board shows correct gating classifications for both open verdict-shaped and non-verdict cards.

**File:** `_estate/bin/pulse-board-truth:301-306` (`card_text`), `:333-335`
(`gating_verdict`'s `title` variable), `:456-467` (`defects`/`open_cards`
report sections)

```python
def card_text(card):
    p = card.get("payload") or {}
    parts = [p.get("title"), p.get("summary"), p.get("why"), p.get("ask"),
             p.get("body"), p.get("detail"), p.get("question")]   # no artifact_name
    ...
title = str(((card.get("payload") or {}) ...).get("title") or "")   # no artifact_name fallback
```

and every place the JSON report embeds a card's title for a human/AI reader
(`"title": (c.get("payload") or {}).get("title")` at `:457`, `:461`, `:467`)
does the same bare `.get("title")` with no fallback.

**Failure scenario:** for any verdict card, `card_text()` returns `""` if
`why`/`summary` are both blank (unlikely but possible), so `gating_verdict()`
short-circuits to `"unknown", "no title or body text to judge"` even when the
card has a perfectly good `artifact_name`; and separately, `title` at line
335 is **always** empty for verdicts specifically (verdicts never carry a
`title` key at all — only `artifact_name`), so `MACHINE_IMPERATIVE_RE` can
never match a verdict card's real name, silently exempting the entire
verdict type from this heuristic. In the JSON report's `open_cards`/
`defects` sections, every verdict card shows `"title": null` — this is the
self-audit tool (whose entire purpose is catching drift like #1/#12/#13) that
would itself misreport if asked "what's the title of this open verdict
card," on the exact class of bug it's built to catch.

**Smallest fix:** same one-line fallback pattern used correctly elsewhere in
this codebase (`p.get("title") or p.get("question") or p.get("artifact_name")
or ...`), applied to `card_text()`'s `parts` list and both `title` derivation
sites.

---

## 14. [HYGIENE] `archive_card`'s docstring claims reversibility that no code implements

> **ANNOTATED (comment corrected, reopen path not built)** — per the finding's own two sanctioned options, took the cheaper one: `archive_card`'s docstring now says "terminal — no reopen path exists today" instead of falsely claiming reversibility. Building an actual `pulse-push reopen`/board-UI affordance was judged out of this fix wave's scope (a real feature addition, not a bug fix) — flagged here as a legitimate follow-up, not silently dropped.

**File:** `_estate/bin/pulse_common.py:446-450`

```python
def archive_card(url, key, card_id, reason):
    # 'retired' is the DB-permitted non-open terminal status (CHECK-constrained);
    # reversible (flip back to 'open'). The SPA hides anything status != 'open'.
    return sb("PATCH", f"pulse_cards?id=eq.{card_id}", url, key,
              body={"status": "retired", "answer": reason, "answered_at": iso(now_utc())})
```

Grepped every call site across `pulse-zero/public/index.html`,
`pulse-zero/bin/pulse-push`, and every `_estate/bin/pulse-*` script for a
PATCH that sets `status` back to `'open'` — **there is none.** No UI button,
no CLI subcommand, no producer script implements the "flip back to open"
half of this comment. A retired card is, in practice, permanently retired
(recoverable only by hand-crafting a PATCH via `psql`/the Management API).
Not a functional bug, but a doc/behavior drift worth fixing before someone
relies on the comment's claim during an incident.

**Smallest fix:** either add the missing `pulse-push reopen --id ID` /
board-UI affordance the comment describes, or correct the comment to say
"terminal — no reopen path exists today."

---

## 15. [HYGIENE] `test-board.sh`'s 25/25 suite has zero coverage of every state-machine, security, and dead-code finding above

> **EXTENDED** — added 6 new unit tests to `test/test_card_contract_gate.py` (URL-scheme gate ×4, uncapped-decision-options ×2) and 9 new checks to `bin/test-board.py` (decision-no-truncation, hostile-body markdown/XSS ×3, touch-target floor, feedback-chip non-overlap, comment-draft preservation, dedupe_key DB constraint, verdict-title-not-"?"). Explicitly NOT covered by this pass, same as the finding names: `mac_commands` RLS under the actual Google OAuth identity (would require driving a real OAuth flow — verified by direct policy inspection instead, see CODE#4), `pulse-drain`'s live race under real concurrent load (verified by code review + the shared conditional-PATCH mechanism's DB-level test, see CODE#3), and `queue_v1=1` (correctly absent — the feature was removed, not fixed, see CODE#5). Full suite state after this pass: `test-board.py` 35/35, `pytest` 23/23, `node --test` 27/27.

**File:** `pulse-zero/bin/test-board.py` (645 lines, 25 named checks)

Enumerated every `ok(...)`/`fail(...)` call name in the file (25 total).
Covered: login (magic-link + admin-generated token + Google-shaped
verifyOtp), dedup-by-key replace-in-place (the *within-open* case only — see
#2's `status=eq.open` scoping, not exercised for the answered/retired case),
title-max on re-push clearing stale checkmarks, typed-action fixture accept
→ verified receipt → auto-resolve, `open_url` step renders as a safe link,
"Ask Pulse" credential-blocking, pagination edge case (101 terminal rows),
realtime subscription *initializes* without callback errors (does not assert
it *delivers* an update), and the feedback-chip/voice-control DOM presence
checks.

**Not covered, confirmed by absence from the 25 names:**
- Any card whose `dedupe_key` collides with a non-open row (#2/#3).
- The verdict-card `artifact_name`-vs-`title` fallback anywhere outside the
  browser (#1/#12/#13 are all CLI/Python, out of this Chrome-only harness's
  reach by construction — meaning **nothing in the repo's test suite covers
  them**, not just this one).
- Double-tap / cross-device answer races (#7) — no test issues two
  concurrent writes to the same card.
- `mac_commands` RLS under the Google identity (#4) — the admin-generated
  login helper (`sb_admin_generate_link`, `:97`) would need to target
  `mw.personalmail@gmail.com` specifically to catch this, and nothing in the
  test asserts on the *identity* used, only that *a* login succeeds.
- `javascript:`/`data:` URL rendering (#6) — the one link-related check
  ("open_url renders as a native safe link") tests the *safe* case only,
  never an adversarial payload.
- `queue_v1=1` at all (#5) — correctly absent, since exercising it would
  currently just confirm the outage; still, a green 25/25 gives no signal
  that this whole subsystem is non-functional in production.

The suite is solid for what it covers (dedup/typed-actions/login/pagination
are meaningfully exercised against a real browser + real DB), which makes
its blind spots more dangerous, not less — a green run reads as "the board
works," and none of the above would move the needle.

---

## Five worst, one line each

1. **#3** — `pulse-drain`'s unconditional `archive_card` PATCH, racing a live Mike answer, silently overwrites his real answer with escalation bookkeeping text and duplicates the ask as "still waiting."
2. **#1** — `pulse-answer-write` prints/lists every verdict card's title as `"?"` — a one-word typo (`artifact` vs `artifact_name`) in the tool built to fix attribution.
3. **#4** — `mac_commands`'s RLS policy only recognizes `mw@mike-wolf.com`, breaking every Mac step-action button when Mike is signed in via Google — the identity the code itself says he actually uses.
4. **#6** — verdict/decision/action card `url` fields render into `href`/`window.open`/iframe `src` with zero scheme validation — a `javascript:` URL from any worker-authored card is a live code-exec path inside Mike's authenticated session.
5. **#5** — the entire "queue v1" feature (view, 3 RPCs, table) referenced throughout `index.html`, `pulse-push`, and the estate's own planning docs does not exist in the production database; the migration was written and never applied.
