# Pulse Zero — DATA-TRUTH audit

_Read-only. `public.pulse_cards` + `public.pulse_card_comments`, Supabase project
`omfwcodoimjmbrhssvfl`, `app_id='pulse-zero'`. Full table pull: 203 cards, 106
comments, fetched 2026-08-14 (creds via `pulse-mac-bridge/.env`). No row
mutated. Cross-checked against `_estate/pulse-queue.jsonl` (21 lines),
`_estate/KEY-REFRESH-LEDGER.md`, `_estate/bin/pulse-board-truth`'s own
2026-08-14T11:30Z run (`_estate/pulse-board/2026-08-14.json`), and `git log`
on `pulse-zero/bin/pulse_card_contract.py` + `_estate/bin/pulse-morning` for
exact fix-deploy timestamps. One lane of a three-lane adversarial review
(live UX, code, and this one — data truth). PERMITTED WRITES: none taken; all
remediation below is prescribed for the fix wave._

## Snapshot metrics (for the fix wave's before/after)

| metric | value |
|---|---|
| total cards | 203 |
| open | 8 (3 action, 2 decision, 3 brief) — 5 of these are "asks" (action/decision/verdict) |
| by status | retired 92 · answered 63 · resolved 36 · open 8 · bounced 4 |
| by type | action 90 · decision 45 · brief 45 · verdict 23 |
| `dedupe_key` present | 114/203 = **56.2%** |
| `dedupe_key` NULL | 89/203 = 44% — **100% of these predate `pulse-morning`'s 2026-08-13T12:03:43Z dedupe fix** (commit `76ea1711`); **zero** NULL-dedupe cards created after that timestamp |
| `created_by = "unknown"` | 5 (not "6+" — see below) |
| titles that derive to empty/"?" | **0** — the render-as-"?" failure mode Tower's own comments describe (`stripEscalationBanner(...) || 'Untitled card'`, `public/index.html:362`) is real in the codebase's fallback path but **no live row currently trips it** |
| action cards missing a required contract field | 0 |
| action cards with no `url`/`actions`/`step_actions:open_url` | 40/90 (44%), **all but one created before the 2026-08-13T11:56:46Z hard-gate deploy** (commit `7ad33baf`); the one post-gate exception (`62e31053`) was created 2026-08-13T10:43:24Z — **also pre-gate**, so the hard gate is airtight: **zero violations since it went live** |
| oldest open card | `225595bd` ("Good morning, Mike." brief) — 29.5h old at audit time |
| oldest open **ask** | `c76afce9` (commons-corpus-width decision) — 26.4h old |
| median time-to-answer, all closes | 24.98h (mean 55.4h; skewed by machine-closed/retired rows sitting for days) |
| median time-to-answer, **human button-click closes only** (55 of them) | **4.39h** — the more honest "how fast does Mike actually move" number |
| escalation lineages found | 23 descendant cards carry a resolvable forward pointer; chain length min 2 / max 4 / mean 2.65 |
| unrecoverable escalation pointers (`"escalated to Day N"` with no target id, pre-08-01 format) | 9 |
| dedupe_key collisions (same key, >1 row) | 7 keys — all explainable (recurring alerts / escalation ladders reusing one key by design), see §5 |

## 1. Rot class inventory, quantified

### 1a. `dedupe_key` NULL — 89 rows (44%), fully bounded, already fixed forward
Every NULL-dedupe row was created before `pulse-morning`'s 2026-08-13T12:03:43Z
fix (commit `76ea1711b9f4`, "morning roundup — buttons not prose, tight digest,
dedupe_key fix"). Zero NULL-dedupe rows exist after that timestamp. This is a
closed wound, not an open one — **no remediation needed on new rows**, only
optional backfill of the historical 89 for search/dedup hygiene (low value,
they're all closed).

**Prescribed backfill (optional, cosmetic only — none of these 89 rows are open):**
```sql
-- No safe backfill exists: dedupe_key was never computed for these rows, so there
-- is no source value to recover it from (unlike a rename, this is a genuine gap,
-- not a stored-elsewhere value). Do not synthesize one. Leave as NULL; the fix
-- forward already stops the bleeding.
```

### 1b. `created_by = "unknown"` — 5 rows, not "6+"
The task brief's "6+ historical" figure does not match the live table. Exactly 5:
`ea8eca73`, `f910492a`, `cfe10a35`, `f30ea554`, `8edf77df` — all retired/resolved,
all from mid-July through 2026-08-07. No open card has `created_by = "unknown"`.
Low priority; these predate any producer-attribution requirement.

**Prescribed:** no fix needed (all closed, none Mike-facing today). If closing
the historical record matters, `UPDATE pulse_cards SET created_by = 'unknown-backfill-2026-08-14' WHERE id IN ('ea8eca73-e8ab-46b5-a85e-d9f8b6512631','f910492a-d01b-43b1-b372-2e3f669d899a','cfe10a35-8117-4378-9d4c-2b0414481a03','f30ea554-18d3-490e-a366-a54ff395405f','8edf77df-1a96-4917-8e0f-4547cdd1ea2b');` — purely cosmetic, skip unless the fix wave has spare cycles.

### 1c. Empty/"?" titles — 0 live instances
Zero cards in the current table have an empty/null/"?" derived title. The
failure mode is real in `public/index.html:362` (`... || 'Untitled card'`) and
Tower's own comment on `b881f78f` (2026-08-01) describes catching exactly this
on a since-resolved chain — but nothing live trips it now. **No action.**

### 1d. Action cards with no link surface — 40/90 historical, 0 live violations of the hard gate
The 2026-08-13T11:56:46Z hard gate (`pulse_card_contract.py`, commit
`7ad33baf`) makes a link-surface-free `action` card an insertion-time
`CardContractError`. Checked every action card against its `created_at`:
**every single no-link-surface row predates the gate**, including the one
edge case (`62e31053`, created 10:43:24Z, 73 minutes before the gate landed at
11:56:46Z). **The gate is holding — zero escapes since deploy.** No remediation
needed; this class is closed by construction going forward.

### 1e. Duplicate asks — one confirmed live-fired duplicate, plus a documented pre-fix escalation-fork pattern
**Confirmed instance (already caught and closed by Tower, useful as the
canonical example for the fix wave):** `90d87409` and `8357f5a3`, both titled
"Rotate the claude@ Gmail app-password", both from `pulse-morning`, 59 minutes
apart (10:01:20Z and 11:00:06Z on 2026-08-13). Root cause per Tower's own
`resolved_note` on `8357f5a3`: neither carried a `dedupe_key` (both predate the
12:03:43Z fix by ~1-2h), so the same-key dedup net never engaged, and
`pulse-morning` re-picked the same queue item (`live-secret-claude-gmail-app-password-rotate`)
on a second run before the first run's `done:true` write landed. Mike had
already answered the first at 10:37:54Z; the second was resolved as a stale
duplicate by Tower at 11:17:52Z, 40 minutes later, per its own text: *"the
second time in two hours the board has done that to him."* This is the same
race documented inline in `_estate/bin/pulse-morning:258-267` (a different but
adjacent incident — the "escaped-a-third-time" near-miss on the exact same
queue key). Closed loop, no further action needed on this pair.

**Structural pattern (pre-08-13, now fixed forward):** normalized-title
clustering found two "forked escalation lineage" cases —
`Miracles Mira project needs a decision` and `Retitle 'Founder's Bundle
security review'` — where `pulse-drain`'s escalation descendants (Day 2/3/4)
carry **`dedupe_key = NULL`** and, in the Miracles Mira case, a **doubled
banner**: `⏫ Day 2 — still waiting: still waiting: Miracles Mira project needs
a decision` (row `d1b05c28`). Cause: before dedupe-key propagation was fixed
(2026-08-13), each escalation step lost the parent's key, so nothing stopped
`pulse-drain` from double-prefixing its own banner on a re-escalation of an
already-escalated title. Both lineages are fully retired/resolved now — dead,
not live rot — but the corrupted-title artifact (`d1b05c28`, `b52ac6bd`) is
worth a cosmetic cleanup since a future full-text search on "Miracles Mira"
will surface the doubled string.

**Prescribed (cosmetic, zero blast radius — rows are retired):**
```sql
UPDATE pulse_cards
SET payload = jsonb_set(payload, '{title}',
      to_jsonb(regexp_replace(payload->>'title', 'still waiting: still waiting:', 'still waiting:')))
WHERE id IN ('d1b05c28-5c03-4880-8e05-29dbf4342973', '32a74582-2725-452e-a09a-2eb840b3f2a0');
```

### 1f. `dedupe_key` collisions (same key on >1 row) — 7 keys, all explainable, not rot
`agi26-inference-review-decision`, `tower-watchdog-respawn-failing` (13 rows!
— pulse-drain's own escalation ladder deliberately reuses one key per design),
`playmaker-gdocs-addon-install`, `buzz-daniel-invite-setup`,
`connect-soma-relay-stripe`, `mark-tailscale-dealbreaker-2026-08-07`,
`tower-watchdog-ax-blocked`. In every case the update-in-place rule (`push_card`
merges into an existing **open** card with the same key) only fires while a
card is open; once closed, a later push with the same key legitimately opens a
fresh row — this is a recurring-alert pattern, not silent duplication. **No
remediation.**

## 2. Open-card truth table (5 asks, all verified against the live estate record)

| card | dedupe_key | STANDS / STALE | evidence |
|---|---|---|---|
| `c76afce9` — Confirm the Mark/James corpus split? | `commons-corpus-width` | **STANDS** | Queue line 10, `done:false`, no comment answers it. Tower already repaired a comma-split rendering bug on this card in place (2026-08-13T14:11:22Z comment: the original `--options` parse shattered one 3-part option into 3 buttons because `_estate/bin/pulse-enqueue:61` splits naively on commas) but left it open, not bounced or resolved — genuinely still awaiting Mike's click. |
| `d1d1618e` — Playmaker #33 mute bug, run the 2-min live voice test? | `playmaker-33-voice-test` | **STANDS** | Tower's own backfilled verdict (2026-08-14T06:18Z): "PASSES both gates... still awaiting you." Needs Mike as the literal second party for a live test — cannot be machine-verified. |
| `65e87e23` — Revoke stale Gmail app password from old archive | `archived-email-app-password-revoke` | **STANDS, but partially superseded — recommend the card be narrowed** | The card's own text hedges between `mikeai@` and `claude@`. `claude@` was independently rotated 2026-08-13 (`KEY-REFRESH-LEDGER.md` §"claude@mike-wolf.com — Gmail app password"), so that half is moot. Tower's comment (`78dd20d9`, 2026-08-14T05:50Z) confirms this is specifically the **`mikeai@`** password — cross-referenced to Locke's review item 4 — and explicitly warns Mike not to revoke the already-rotated `claude@` entry by mistake. **Prescribed:** edit the card in place (same `dedupe_key`) to drop the `claude@` mention entirely before Mike opens it, to remove a genuine mis-click risk Tower already flagged. |
| `7fc788c0` — Accept Stephanie's Stripe invite, mint restricted key, copy | `stripe-teammate-key-mint` | **STANDS** | Depends on an external event (Stephanie's invite email arriving) that has no automated confirmation signal on this side — genuinely can't be verified closed without Mike's clipboard action. |
| `0c56403c` — Mint KeyDrop's own Netlify token | `keydrop-pat-mint` | **STANDS** | Tower verdict (2026-08-14T05:20Z): "PASSES both gates... genuinely Mike-gated — Netlify has no API path to a scoped token." Note: `pulse-board-truth`'s heuristic gating classifier flags this `suspect-not-mike-gated` (triggers on the word "redeploy" in its `why`) — a **false positive**, already correctly overridden by Tower's manual review. Worth tightening `MACHINE_SOLVABLE_RE` in `_estate/bin/pulse-board-truth` to not fire on "redeploy" when it appears only in adjacent/explanatory text, not the actioned verb — flagged for the code lane, not fixed here. |

All 5 open asks are genuine, none stale, none already answered elsewhere. Zero
"the fix already shipped, revoke the ask" instances found among current open
cards — a real improvement over the class of bug this review was looking for
(cf. the `65e87e23` partial-supersession above, which is the closest thing to
it, and Tower had already caught the sharper half of it).

## 3. Comment orphans

Read-side note: `pulse_common.live_threads()` (added 2026-08-11) already
reconstructs full lineages for **open** cards, so any comment sitting on a
non-open ancestor of a currently-open card is NOT actually lost — it's
correctly merged forward by that helper. True orphans are comments sitting on
a **closed** lineage whose live tip is *also* closed (so nothing ever merges
them forward for a human to see) or whose forward pointer is unrecoverable.

**True orphan class — 2 instances, both historical, both practically resolved:**
- `3c100931` (retired, "escalated to Day 2" with **no parseable target** —
  pre-2026-08-01 format) carries a live 2-comment exchange (Mike asking about
  a stale Pulse build, Dee replying same day). The reply happened in-session,
  not via the automated open-card scan, so nothing was actually missed — but
  structurally this thread is invisible to any future automated audit of "did
  Mike get answered."
- `b881f78f` (retired, resolvable pointer → `eba8bd68` → `a7df16e5` →
  `18dc1566`) carries Tower's own 2026-08-01 comment flagging the exact empty-title
  bug documented in `pulse_common.py`'s own source comments as the motivating
  case for building `live_threads()`. **Independently reproduced here**: the
  chain's live tip (`18dc1566`) is now `status=resolved` — the bug this
  comment flagged is fully closed out, confirming the 2026-08-11 fix worked.

**Unrecoverable escalation pointers (structural, not orphan-with-comments):**
9 cards say `"escalated to Day N"` with no parseable target UUID (pre-08-01
format, listed in full in the script output — ids `4baf49d4`, `52afc7d6`,
`cd3ef919`, `e2a14a1a`, `22ec554d`, `e105b0ba`, `3c100931`, `1dd9d9d6`,
`55e66d4a`). None of these carry comments except `3c100931` above. No fix
possible (the link genuinely wasn't recorded); no remediation prescribed.

**Mike comments with no reply:** **0.** Every comment thread where Mike wrote
the last word actually has a fleet reply after it — checked across all 106
comments on all cards, not just open ones. This is a clean result; the
pulse-answer loop is closing threads.

**"Dee replies that answered nothing":** none found by inspection — every Dee/
Tower reply in the transcript either answers a direct question, records a
verdict, or reports a completed fix. No hollow acknowledgments detected.

## 4. Queue⇄board consistency (`_estate/pulse-queue.jsonl`, 21 lines)

| finding | detail |
|---|---|
| `done:false`, card actually closed | **2** — `mark-call-transcript-share` (card `776a6e79`, answered 2026-08-14T15:54:41Z) and `fleet-answers-eric-directly` (card `8a679c60`, answered 2026-08-14T15:54:21Z). Both are Mike's own button-click answers from ~minutes before this audit ran. |
| `done:true`, card open | **0** |
| `card_id` pointing at a deleted row | **0** |
| queued, never promoted (`card_id: null`) | **1** — `session-lease-protocol`, added 2026-08-14, `delivered: null`. Not yet drained to a card. |

**Root cause of the 2 stale-`done` items, confirmed by reading the code:** the
queue's `done` flag is written back **only inside `pulse-morning`**
(`_estate/bin/pulse-morning:280-284`), which runs once a day (~10-11am). There
is no event-driven sync-back when Mike answers a card directly on the board —
the queue file will show `done:false` for up to ~24h after a same-day board
answer until the next morning run reconciles it. This is exactly the gap
Mike ratified fixing on 2026-08-13 (queue item `pulse-event-driven-fix`,
"Everything possible should be event driven") — **already flagged and queued
as work, not a new finding**, but worth citing here as live, current evidence
of the exact lag the fix is meant to close (both instances are <2h old at
audit time and will self-heal at tomorrow's ~10am run if the event-driven fix
hasn't landed by then).

**`session-lease-protocol`:** added to the queue 2026-08-14 with no
`delivered` timestamp and `card_id: null` — sitting un-promoted. Not
necessarily a bug (queue items are drained by `pulse-morning`/`pulse-promote`
on their own schedule and this was added today), but flag for the fix wave to
confirm it's still pending drain rather than silently dropped.

## 5. Escalation lineage health

23 descendant cards carry a resolvable forward pointer (`"escalated to Day N →
<uuid>"`). Chain lengths: min 2, max 4, mean 2.65. The longest chain
(`18dc1566 → a7df16e5 → eba8bd68 → b881f78f`, the Mark/Tailscale/DPlus ask) is
the exact 4-deep chain cited by name in `pulse_common.py`'s own source
comments as the motivating bug for building `live_threads()` — **confirmed
resolved**: its live tip is `status=resolved`. No open lineage today exceeds
depth 1 (every currently-open card's own `chain_len == 1` — none of the 8 open
cards are themselves escalation products right now, they're all first-run
asks). No loops detected in any chain (cycle guard never tripped).

## 6. Worst three rot classes (for the final message)

See below.

---
_Prepared by Dee (data-truth lane), 2026-08-14. Reversal: delete this file,
nothing else was touched. Companion lanes: live UX, code review (not authored
here)._
