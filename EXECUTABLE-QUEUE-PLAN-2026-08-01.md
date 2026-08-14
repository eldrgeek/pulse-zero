# Pulse Zero executable queue plan

**Status:** RETIRED-UNBUILT (2026-08-14, CODE review #5). The migration below
was authored 2026-08-01 and never applied to the live database. The frontend
code that assumed it existed (~250 lines: `loadQueueCardsV1`/`renderQueueCard`/
`queueCardTitle`/`queueExecutionLabel` in `public/index.html`, the whole of
`public/pulse-queue.js`, the `?queue_v1=1` flag, `pulse-push`'s `--queue-v1`
authoring path and `validate_queue_contract`) was removed rather than gated,
per the adversarial-review fix wave: it shipped to every board load and did
nothing in production except add attack surface, and it read as a live
feature to anyone who hadn't checked the schema. If this direction is revived,
start from this doc and the still-present (unapplied)
`supabase/migrations/20260801_executable_queue_v1.sql` — do not re-derive the
design, but also do not re-add the frontend branches until the migration is
actually applied and verified against the live schema.

**Original status:** Design only; no production migration or deployment authorized
**Date:** 2026-08-01
**Authorship:** Mike Wolf product direction; OpenAI Codex (GPT-5) repository audit and implementation plan, prepared as the Pulse executable-queue teammate
**Scope:** `pulse-zero`, `pulse-mac-bridge`, and Yeshie integration. This plan does not change the live board, Supabase schema, bridge daemon, or Netlify deployment.

## Outcome

Pulse Zero should stop being an open-card inbox and become a bounded focus queue:

- zero to five cards, ordered by explicit priority rather than creation time;
- every visible card is a real blocker that only Mike can clear;
- every routine web or Mac step is already automated;
- Mike sees only one of four human gates: authentication, consent, money, or judgment;
- the system opens the exact surface and highlights the exact control when the gate is outside Pulse;
- automation resumes after Mike acts, verifies the outcome independently, and then closes the card;
- overflow, malformed, duplicate, routine, and legacy cards never compete for Mike's attention.

An empty board is success. The queue must never be padded to five.

## Verified current state

The audit on 2026-08-01 found:

1. `pulse-zero/public/index.html` queries every `status=open` card, orders by `created_at DESC`, and renders them all. There is no explicit priority or five-card bound.
2. The live board currently has eight open cards. None has `payload.actions`; all eight therefore depend on links, prose, or native answer buttons.
3. Two live cards describe overlapping versions of the same DPlus/VPS-access judgment, demonstrating that deduplication by source/title is not enough to preserve one decision unit.
4. Typed `payload.actions` v1 exists and is materially better than the legacy Yeshie button: stable action IDs and revisions, durable `mac_commands` receipts, idempotent retries, resumable human gates, and verified completion.
5. The browser currently inserts the full action envelope into `mac_commands`. The local broker validates it, but the database does not construct the command from the server-authoritative card.
6. `pulse-mac-bridge` fails unknown action pairs closed, but its reviewed typed-action allowlist contains exactly `workflow/gdoc_bridge_authorize`.
7. That operation already demonstrates the desired control loop: preflight, open ChromeMain, ask Yeshie to highlight an allowlisted control without clicking, wait on the same queue row, re-probe, and finish only after Drive verification succeeds.
8. The old `yeshie_task` button remains behind `?yeshie=1`. It is a compatibility surface, not a dependable new-card contract.
9. Current unit baselines are green: 13 Node tests and 9 Python tests in `pulse-zero`, plus 18 Python tests in `pulse-mac-bridge`.

## Product invariants

These are acceptance rules, not aspirations.

### Queue invariants

- The default board reads only a server-defined active-queue projection.
- The projection returns at most five rows with unique positions 1 through 5.
- Recency is never the primary rank signal.
- Only open, unsnoozed, contract-valid, execution-ready cards are eligible.
- `BRIEF` cards and informational updates cannot enter the active queue.
- One blocked outcome is one card. The steward merges duplicate cards before promotion.
- Answering, resolving, retiring, bouncing, snoozing, or invalidating a card releases its slot and triggers reconciliation.
- A queue may contain fewer than five cards when fewer than five honest gates exist.

### Human-gate invariants

- `authentication`: Mike must prove identity or supply an identity-bound secret/code.
- `consent`: Mike must authorize access, accept an invitation, communicate externally, or approve an irreversible/shared action.
- `money`: Mike must approve a charge, price, subscription, transfer, or purchase.
- `judgment`: Mike must supply taste, values, strategy, prioritization, or acceptance criteria that software cannot infer safely.
- No other gate kind is accepted. A device test, terminal command, page navigation, copy/paste, session lookup, or routine form fill is automation work, not a fifth category.

### Execution invariants

- A static context link may open directly in a new tab. It does not count as completing an operation.
- An operation is referenced by a reviewed operation ID, never by arbitrary shell, selector, URL, recipe path, or JavaScript supplied by a card.
- Web/workflow operations use Yeshie for routine work. Mac operations use a reviewed local handler and honor `afk_guard` where foreground control is involved.
- A human gate is displayed only after the executor reports that the exact target is ready.
- Yeshie highlights and waits on authentication, consent, money, and judgment controls; it does not click them for Mike.
- The same durable run resumes after the gate. Mike does not press a second “continue” button.
- Success requires a named, independent verification result. “The click happened” and “the command exited zero” are not sufficient.
- Raw executor output and secrets never reach the card, receipt, logs, or comments. The UI shows only an allowlisted `safe_message` and a redacted verification summary.

## Data model

Keep `pulse_cards` as the history/intake record. Add a queue projection instead of turning `status` into an overloaded ranking field.

### Additive `pulse_cards` columns

```sql
alter table public.pulse_cards
  add column contract_version smallint,
  add column gate_contract jsonb,
  add column continuation_contract jsonb,
  add column queue_state text not null default 'legacy',
  add column queue_position smallint,
  add column priority_band smallint,
  add column priority_reason text,
  add column deadline_at timestamptz,
  add column blocked_work_count integer not null default 1,
  add column mission_lane text,
  add column eligible_at timestamptz,
  add column contract_hash text,
  add column eligibility_errors jsonb not null default '[]'::jsonb;

alter table public.pulse_cards
  add constraint pulse_queue_state_check
    check (queue_state in ('legacy', 'intake', 'eligible', 'queued', 'hold')),
  add constraint pulse_queue_position_check
    check (queue_position is null or queue_position between 1 and 5),
  add constraint pulse_priority_band_check
    check (priority_band is null or priority_band between 0 and 3),
  add constraint pulse_blocked_work_count_check
    check (blocked_work_count >= 0);

create unique index pulse_one_card_per_queue_position
  on public.pulse_cards(queue_position)
  where queue_state = 'queued' and queue_position is not null;
```

Meanings:

- `legacy`: existing card not yet classified; never eligible by default.
- `intake`: newly submitted card awaiting contract validation and stewardship.
- `eligible`: valid Mike gate, ready to rank, currently outside the top five.
- `queued`: one of the active top five.
- `hold`: invalid, duplicated, missing automation, or otherwise not ready. `eligibility_errors` explains why.
- `priority_band`: 0 critical, 1 active critical path, 2 single active stream, 3 non-urgent judgment.
- `queue_position`: a materialized, auditable rank, not a client-side sort.

Do not put `queue_position` inside `payload`: it must be queryable, constrained, and updated transactionally.

### Gate contract v1

```json
{
  "version": 1,
  "kind": "authentication|consent|money|judgment",
  "reason_only_mike": "One sentence explaining the irreducible boundary.",
  "estimated_human_seconds": 30,
  "target": {
    "surface": "pulse|web",
    "label": "Accept invitation",
    "url": "https://github.com/orgs/InaraiLLC/invitation",
    "ref": "github.org_invitation.accept"
  }
}
```

Rules:

- `target.surface=pulse` is for judgment performed by Pulse buttons. `url` and `ref` may be omitted because the card itself is the exact surface.
- `target.surface=web` requires HTTPS, an allowlisted host pattern, an abstract target `ref`, and a human-readable label.
- The browser URL in the card is context. The executor's runtime receipt records the actual resolved tab/URL and `target_ready`; the UI must not announce “your turn” before that receipt exists.
- Money gates additionally require structured amount, currency, payee, and maximum authorized amount. Never bury money details in prose.

### Continuation contract v1

Every card needs a return path after Mike acts, including `DECISION` and `VERDICT` cards that currently become terminal immediately.

```json
{
  "version": 1,
  "owner_ref": "ccd:<stable task or workflow id>",
  "trigger": "gate_answered|actions_verified",
  "operation": "resume_card_owner",
  "correlation_key": "stable non-secret key",
  "verification": {
    "kind": "owner_acknowledged|external_state|artifact_state",
    "params": {}
  },
  "success_message": "Invitation accepted and DPlus setup resumed."
}
```

For a web/workflow action, the action's verifier may satisfy both operation completion and continuation. For direct Pulse judgment, the answer first creates a continuation run; the card remains in a visible “team resuming” state until the owner acknowledges or the named external/artifact state verifies.

### Queue history

Add an append-only `pulse_queue_events` table:

```text
id, card_id, event_type, from_state, to_state, from_position, to_position,
reason, actor, contract_hash, created_at
```

This supplies the audit trail needed to measure churn, queue age, bounce rate, duplicate repairs, and whether Mike's actions actually unblock work. Do not infer history from the latest card row.

## Ranking and reconciliation

Use a deterministic lexicographic comparator. Avoid an opaque AI-generated score.

1. `priority_band` ascending:
   - P0: security/outage or a real deadline inside 24 hours;
   - P1: blocks Legends, then Playmaker, or blocks two or more active workers/workflows;
   - P2: blocks one active project or external collaborator;
   - P3: non-urgent taste/strategy judgment.
2. `deadline_at` ascending, null last.
3. Mission lane: Legends, Playmaker, other active SOMA work, everything else.
4. `blocked_work_count` descending.
5. `eligible_at` ascending to prevent starvation.
6. `id` ascending as a stable final tie-breaker.

`priority_reason` is mandatory and rendered on the card as “Why now.” It must name the deadline or blocked work, not restate the title.

Implement `reconcile_pulse_queue()` as a transactional database RPC or a single steward process protected by a Postgres advisory lock:

1. Clear slots held by terminal, snoozed, invalid, or no-longer-blocking cards.
2. Validate every `intake` and changed `eligible/queued` card against the canonical contract.
3. Move invalid/duplicate/not-ready cards to `hold` with structured reasons.
4. Select the first five eligible rows using the comparator.
5. Clear existing positions, then assign new positions 1–5 in the same transaction.
6. Append queue events for every state/position change.
7. Return the active queue plus an overflow count, not the overflow contents.

Invoke reconciliation after push/update, answer, verified completion, snooze/unsnooze, bounce/resolve/retire, and action-contract revision. Also run it every minute so expired snoozes re-enter without user intervention. The function must be idempotent.

## UI behavior

The default Pulse Zero page should render only `pulse_active_queue_v1`, ordered by `queue_position`, with a hard client-side `limit(5)` as defense in depth.

### Header

- Title: `Needs Mike`.
- Count: `N real blockers`, not `N open`.
- Optional quiet line: `M ready behind this queue`; do not expose a scrollable inbox.
- If there are zero cards: `Nothing genuinely needs you. The team is working.`

### Card

- Rank marker 1–5.
- One imperative title.
- Gate badge: Authentication, Consent, Money, or Judgment.
- “Why now” from `priority_reason`.
- One sentence explaining why only Mike can clear it.
- Estimated human time.
- One primary executable control.
- `More context`, `Ask Pulse`, and `Snooze` as secondary controls.

The first card is expanded. Cards 2–5 are compact until tapped. This keeps the queue visible without making five cards feel like five simultaneous demands.

### Execution states

Use explicit states rather than a generic spinner:

```text
Ready -> Team preparing -> Your turn: <exact control>
      -> Team resuming -> Verifying -> Cleared
                               \-> Could not verify / safe retry
```

- “Your turn” appears only when `human_gate.target_ready=true`.
- The target label must match the highlighted control.
- While waiting, the action button is disabled; reloading resumes the same attempt.
- After Mike acts, the daemon detects the state change and resumes automatically.
- A card disappears only after verification and continuation succeed.
- A failed verifier keeps the card in place with a safe retry or `Ask Pulse`; it must never claim success.

### Judgment cards

- Options and required context appear directly on the card.
- “Other” remains available, but is not a substitute for a complete option list.
- Tapping an option records the gate answer and starts the continuation; it does not immediately erase the card.
- `VERDICT` Accept/Change/Retire uses the same continuation/verification path.

### Compatibility surfaces

- Keep answered, snoozed, bounced, and legacy history off the default page.
- A separate authenticated diagnostic route may expose them to the team.
- Do not show the old `Yeshie: do it — I'll watch` control on a queued card.
- `yeshie_task`, `yeshie_steps`, `step_actions`, and generic `Done` remain read-compatible only during migration.

## Action-contract enforcement

### 1. Canonical contract

Place a canonical JSON Schema plus reviewed operation registry in `pulse-mac-bridge`, the execution owner. Generate/vendor the browser and `pulse-push` validators into `pulse-zero`, and add a CI checksum test so the copies cannot drift silently.

The schema validates common structure. Each operation registry entry validates behavior-specific fields.

### 2. Server-authoritative enqueue

Replace the browser's direct `mac_commands.insert(full_action_payload)` with an authenticated RPC:

```text
enqueue_pulse_action(card_id, action_id, revision, attempt)
```

The RPC:

1. verifies Mike's authenticated identity;
2. requires the card to be open and queued;
3. reads the action from the stored card, rather than trusting a browser-supplied action object;
4. verifies contract version/hash and action revision;
5. constructs the idempotency key;
6. inserts or returns the existing durable command row;
7. returns only safe receipt fields.

Revoke direct authenticated-browser INSERT permission on `mac_commands` after the RPC is live. Preserve service-role insertion for the bridge, webhooks, and voice tools.

### 3. Reviewed handler registry

Refactor the broker's hard-coded Google branch into operation specifications such as:

```python
OperationSpec(
    executor="web",
    operation="github_accept_org_invite",
    params_schema=...,
    target_refs={"github.org_invitation.accept": ...},
    preflight=...,
    prepare=...,
    resume=...,
    verify=...,
    redact=...,
)
```

Every spec must define:

- strict params (`additionalProperties: false`);
- allowed hosts and abstract target refs;
- whether foreground Mac control needs `afk_guard` or a fresh explicit click;
- a preflight that completes silently if already satisfied;
- the routine automation phase;
- the optional human-gate phase;
- resume behavior;
- independent verification;
- redaction and safe user messages;
- retry/idempotency behavior.

Never add a generic `shell`, `run_recipe`, arbitrary URL, or arbitrary selector operation. Expanding the allowlist means adding one reviewed capability family with its tests.

### 4. Durable claim and lease

The current daemon polls `status=open` rows without atomically claiming them. Before running more than one bridge instance, add `claimed_by`, `lease_expires_at`, `next_poll_at`, and `updated_at`, plus an atomic `claim_mac_commands(worker_id, limit)` RPC.

New typed-run states should be explicit: queued, running, waiting_human, verifying, succeeded, failed, cancelled. A compatibility view may map queued/running/waiting_human back to legacy `open` and succeeded to `done` while old consumers are migrated.

Human-wait rows use bounded backoff via `next_poll_at`; they should not hammer the provider every two seconds forever.

## Migration and compatibility

### Phase 0: evidence and backups

- Export the current `pulse_cards`, `pulse_card_comments`, and related typed `mac_commands` rows.
- Record the current counts and contract mix.
- Keep the live query/UI unchanged.
- Add a feature flag for `queue_v1` and a one-command rollback to the legacy query.

### Phase 1: additive schema and shadow ranking

- Add nullable contract/ranking fields, queue events, constraints, views, and reconciler.
- Existing rows default to `queue_state=legacy`, so no card is silently promoted.
- Add CLI authoring flags for gate, continuation, and priority metadata.
- Run the reconciler in shadow mode and compare its proposed queue with the legacy board for several days.

### Phase 2: repair the current eight open cards

Likely disposition from the read-only audit; Tower must confirm against current owners before any mutation:

- Merge the two DPlus/VPS-access cards into one self-contained `judgment` card.
- Convert the GitHub organization invite into a `consent` card with a reviewed exact-target handler.
- Split or sequence the Hugging Face, ElevenLabs, and Netlify revocations as reviewed consent/security actions; Yeshie performs navigation and highlights only the irreversible controls.
- Repair the private Miracles/Mira item into a self-contained `judgment` contract or hold it if the context cannot be presented safely.
- Hold the Fieldy phone-key card until an exact, approved phone/deep-link path exists; prose telling Mike to shuttle a secret is not queue-ready.
- Hold the offline Pixel test until Pulse can deep-link to the exact app state and automate all setup outside Mike's actual judgment.
- Bounce the session-retitle card as routine ownership work unless its owner can identify a concrete judgment that only Mike can make.

This produces an honest queue of roughly three or four cards, not a forced five.

### Phase 3: opt-in UI

- Deploy the additive queue UI behind `?queue_v1=1` or a server-side flag.
- Run read-only and test cards first.
- Exercise snooze, answer, failure, retry, refresh-resume, verification, and slot refill.
- Compare active queue IDs against the database view on every smoke run.

### Phase 4: default switch

- Make the active-queue view the default only after Mike approves the preview.
- Keep the legacy route for one rollback window.
- Change `pulse-push` so uncontracted cards enter `intake/hold`, never the default board.
- After all producers migrate, make gate and continuation contracts mandatory for queue eligibility.

### Phase 5: retire legacy execution

- Remove `?yeshie=1` and the old Yeshie button after no open card depends on them.
- Keep historical fields readable; do not destructively rewrite old cards.
- Revoke browser direct inserts to `mac_commands` after all UI callers use the enqueue RPC.

## Smallest meaningful vertical slice

Use the live “Accept InaraiLLC/dplus GitHub org invite” blocker. It is a real consent gate, has an exact destination, and can be verified independently.

### Slice scope

1. Add the additive queue columns/view/reconciler and feature-flagged UI.
2. Implement one reviewed broker operation: `web/github_accept_org_invite`.
3. Convert only that card to gate/continuation contracts and a typed action.
4. Promote it through the shadow reconciler to one queue slot.
5. On Mike's action-button tap:
   - preflight GitHub authentication and pending invitation state;
   - use Yeshie to open the exact invitation page and perform routine navigation;
   - highlight `github.org_invitation.accept` and wait without clicking;
   - after Mike clicks, resume the same run automatically;
   - verify via GitHub's membership/invitation API that membership is active and the invite is no longer pending;
   - resume the originating DPlus workflow and require its acknowledgment;
   - mark the card cleared and reconcile the next slot.

If the browser is not authenticated, the card must not improvise. Either a separately reviewed `github_authenticate` action is already present before the consent action, or the card remains on hold with a precise contract-repair error.

### Slice acceptance criteria

- The feature-flagged board returns no more than five cards and shows this card at its server-assigned position.
- A second browser tap during the same attempt returns the same command row.
- Yeshie proves the exact invitation tab and target before Pulse says “Your turn.”
- Yeshie never clicks Accept.
- Refreshing phone or Mac during the wait resumes the same checkpoint.
- The card cannot close on a click alone; GitHub state and workflow acknowledgment must verify.
- Failure and timeout reveal no tokens, raw DOM, selectors, or provider bodies.
- Snoozing releases the slot; unsnoozing re-ranks rather than jumping to the top by recency.
- The legacy default page remains unchanged until Mike explicitly approves the switch.

This slice proves the whole product claim with one operation. Do not expand the allowlist to the other live cards until this path is green.

## Verification plan

### Unit tests

- Gate taxonomy accepts only the four allowed kinds.
- Queue eligibility rejects briefs, missing gates, missing continuation, prose-only operations, arbitrary selectors/URLs/recipes, unverified completion, and unsupported operation pairs.
- Priority comparator is stable and ignores creation time except the explicit starvation tie-breaker.
- Contract hash changes when behavior changes; unchanged retries preserve it.
- Browser/CLI/broker validators accept and reject the same fixture corpus.
- Every handler redacts secrets and returns only safe fields.
- Idempotency, retry, checkpoint, and verifier behavior survive process restart.

### Database tests

- Unique queue positions and `1..5` constraints hold under concurrent reconciliation.
- Ten simultaneous eligible inserts still produce at most five queued rows.
- Terminal/snoozed/invalid cards cannot appear in `pulse_active_queue_v1`.
- Resolving/snoozing a queued card causes deterministic refill.
- RLS limits Mike-facing reads/writes correctly and denies unapproved direct command inserts.
- Enqueue RPC rejects a nonqueued card, stale revision, changed hash, unsupported action, and non-Mike user.
- Queue events record every promotion, demotion, move, and release.

### Contract/integration tests

- Run the shared valid/invalid fixtures in JavaScript and Python.
- Simulate preparation, target-ready, human wait, resume, verify, and continuation acknowledgment.
- Start two bridge workers and prove atomic claim prevents double execution.
- Kill/restart the bridge at every checkpoint and prove resume.
- Rotate an action revision and prove an old receipt cannot certify it.
- Verify that legacy cards remain readable and cannot become queued accidentally.

### Staging E2E

- Use an isolated `app_id` and test identities/data.
- Playwright verifies the five-card bound, server order, compact/expanded UI, exact state labels, refresh recovery, snooze/refill, and inaccessible diagnostic history.
- Run Yeshie against a controlled consent fixture page first, then the real GitHub invitation in prepare/highlight-only mode.
- Capture the safe receipt and queue-event trail as the release artifact.

### Production canary, only after approval

- Export/backup affected rows.
- Enable `queue_v1` for Mike only.
- Run the GitHub invitation slice with Mike present for the consent click.
- Confirm GitHub membership independently, owner-workflow acknowledgment, card closure, and deterministic refill.
- Roll back the feature flag immediately on any mismatch; do not rewrite historical rows.

## Delivery order

1. Canonical schemas, fixture corpus, and queue/gate validators.
2. Additive database migration, active-queue view, events, and reconciler.
3. `pulse-push` contract authoring/audit support.
4. Server-authoritative action-enqueue RPC and RLS change behind a flag.
5. Broker operation registry and durable claim/lease.
6. GitHub invitation handler and verification.
7. Feature-flagged five-card UI.
8. Shadow ranking and live-card repair.
9. Approved canary.
10. Default switch, producer enforcement, then legacy-button retirement.

Dependencies are intentional: the UI must not expose a card until the database can bound/rank it and the broker can execute its operation; the allowlist must not expand until enforcement and receipts are in place.

## Decisions needed before implementation

Only two product decisions remain material:

1. Whether “judgment delivered to the originating owner” is enough to close a decision card, or whether every decision also needs a second external/artifact verification. Recommendation: require owner acknowledgment for v1 and stronger external verification where one exists.
2. Whether a manual rank override is necessary. Recommendation: omit it from the first slice; add an expiring, reason-required override only if shadow ranking produces a real counterexample.

Everything else can be implemented incrementally without changing the core product intent.
