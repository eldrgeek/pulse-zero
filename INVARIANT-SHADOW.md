# Pulse Zero feedback invariant shadow

**Status:** implemented, off by default; no migration or deployment
**Authorship:** Mike Wolf (product direction) and OpenAI Codex (GPT-5 implementation pass), 2026-08-01

Pulse Zero's existing feedback function still inserts each accepted report in
`pulse_zero_feedback` with `status=new`. Its additive response fields now also
include:

- `work_item_id` — a conservative exact fingerprint over site/page/URL/area/text;
- `submission_receipt_id` — a distinct receipt tied to the inserted feedback row;
- `fingerprint` — the privacy-safe content hash used for exact linkage.

The same normalized report maps to the same work item while each stored
submission remains independently receipted. Different scope or text maps to a
different item. This is identity/linkage only: it does not create a queue,
assign an owner, merge/delete rows, or migrate the existing table.

## Local shadow evaluation

```bash
SOMA_INVARIANT_SHADOW=1 \
SOMA_INVARIANT_GATE=../SOMA/tools/soma-invariant-gate \
netlify dev
```

`netlify/functions/soma-invariant-shadow.js` normalizes the accepted row into
`soma-invariant-check-input/1` and invokes the SOMA-owned command. The call has
a two-second bound, uses `--enforcement shadow`, and cannot alter the feedback
function's status code. Missing or failed evaluation is logged as degraded.

No production environment flag, schema migration, queue/card behavior, hook,
service, notification, or deploy is included in this slice. Queue ranking and
typed-card eligibility remain the separate executable-queue implementation's
scope.
