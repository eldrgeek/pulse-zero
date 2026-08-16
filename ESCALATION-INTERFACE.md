# Delegate-upwards: the escalation interface

The contract between a reader-facing AI surface and Mike's Pulse Zero board,
for the case the AI **cannot** answer. Built 2026-08-16 for the Common Ground
conclusions surface (audience: Mark Inarai); nothing in it is specific to that
page except the default `asker` name and the `mark-qa-` key prefix.

Two components consume this: the **answerer** (server-side, holds the model key
and the escalation secret) and the **page** (browser, holds neither). Their
files are not mine — this document is the seam.

---

## The rule

An answer the AI is not sure of is worse than no answer, and a pending state
nothing will resolve is worse than an error. So:

1. When the AI cannot answer, it escalates. It does not guess.
2. The escalation is a real card on Mike's real board. There is no second
   mechanism, no queue of our own, no "we'll email him".
3. The page tells the reader exactly what happened, from real rows — including
   the ugly cases. `failed` is a state the page must render.

## Why it is filed through the Mac and not written directly

`pulse_card_contract.py` is the single enforcement point for the board, and it
is Python. A Netlify function POSTing `/rest/v1/pulse_cards` bypasses it
entirely — which is the exact hole `_estate/bin/pulse-board-truth` exists to
audit for. So `escalate-question.js` queues a `mac_commands` row and
`pulse-mac-bridge/bridge.py :: escalate_question` (poll interval 2s) shells out
to `pulse-zero/bin/pulse-push`.

**Named cost:** escalation depends on the Mac being up. That is not hidden —
`escalation-status.js` flips a queued-but-unclaimed escalation to `failed`
after 180 seconds and says so in words, so a reader is never left waiting on a
worker that is not running.

---

## 1. Answerer → board

```
POST https://pulse-zero.netlify.app/.netlify/functions/escalate-question
headers:
  content-type: application/json
  x-pulse-secret: $PULSE_TOOL_SECRET     ← server-side only, never in a bundle
```

| field | req | meaning |
|---|---|---|
| `question` | ✅ | the reader's question, **verbatim** — not your paraphrase |
| `unresolved` | ✅ | what you could not resolve, and why. This is the honest part; it is what Mike reads first |
| `question_url` | ✅ | absolute `https` deep link to this question on the page. **Hard requirement** — an action card with no link surface is a `CardContractError (no_link_surface)`, so there is no silent fallback |
| `topic` | | ≤ 40 chars, the gist. Becomes `Answer <asker>: <topic>`. Omit and it is cut from the question's first clause |
| `asker` | | default `Mark` |
| `tried` | | what you checked before giving up. Renders on the card |

**200**

```json
{
  "ok": true,
  "key": "mark-qa-XXXXXXXXXXXX",
  "state": "filing",
  "filed_at": "2026-08-16T16:41:14.237Z",
  "mac_command_id": 80,
  "status_token": "<32 hex, minted per escalation — a read capability, treat it as one>",
  "status_url": "https://pulse-zero.netlify.app/.netlify/functions/escalation-status",
  "expectation": {
    "basis": "Mike's board gets a scheduled pass every morning at 07:00 America/Denver. He usually reads it sooner than that. There is no SLA and nothing here promises one.",
    "next_scheduled_review": "2026-08-17T13:00:00.000Z"
  }
}
```

Hand `key` + `status_token` + `status_url` to the browser. They are safe there:
the token is `HMAC-SHA256(PULSE_TOOL_SECRET, "escalation:<key>")`, so it is a
read capability for exactly one escalation and forges nothing.

**Other codes:** `400` bad shape (message names the field) · `401` bad secret ·
`503` `PULSE_TOOL_SECRET` or `PULSE_ZERO_SERVICE_KEY` not set on the site —
fails loud, never drops the question quietly · `502` board unreachable.

### The key is per-question, on purpose

`key = "mark-qa-" + sha256(question, lowercased, whitespace-collapsed,
trailing punctuation stripped)[:12]`.

`pulse-push --key` dedup matches **open** cards only. Per-question means a
re-ask updates the card Mike is looking at instead of minting a second one, and
a question he already answered can be asked again and gets a fresh card. A
per-topic-forever key would do neither.

## 2. Page → status

```
GET https://pulse-zero.netlify.app/.netlify/functions/escalation-status
      ?key=<key>&t=<status_token>
```

```json
{
  "key": "...", "state": "waiting",
  "headline": "This one went to Mike. It is on his board, unanswered.",
  "detail":   "No AI is going to answer it for him.",
  "filed_at": "...", "card_id": "...", "board_url": "https://pulse-zero.netlify.app",
  "human_reply": null, "replies": [],
  "expectation": { "basis": "...", "next_scheduled_review": "..." },
  "checked_at": "..."
}
```

`headline` and `detail` are written to be rendered as-is. If you write your own
copy, keep the meaning — especially for `failed`.

| `state` | means | the page must say |
|---|---|---|
| `filing` | queued, < 3 min | going to Mike now |
| `waiting` | card is open on the board | it reached him; he has not answered |
| `answered` | he resolved/answered/commented | show `human_reply` **verbatim** |
| `bounced` | he sent it back | show `human_reply` (his reason) |
| `failed` | never reached him, or the card is gone | **say so.** Nobody is waiting on it |
| `unknown` | no escalation was ever filed for this key | nothing is pending |

**Poll every ~10s while `filing`, every ~60s while `waiting`.** Stop on
`answered` / `bounced` / `failed` / `unknown`.

`human_reply` is Mike's words, unedited, shown to the reader. The card tells him
that in as many words, so it is not a surprise — but do not paraphrase it, and
do not let the AI rewrite it.

## 3. Copy-paste client

`/escalation/escalation-client.js` on this site — a zero-dependency ES module.

```js
import { pollEscalation } from 'https://pulse-zero.netlify.app/escalation/escalation-client.js';

const stop = pollEscalation(receipt, (s) => {
  el.dataset.state = s.state;
  el.textContent = s.state === 'answered' ? s.human_reply : s.headline;
});
```

Copy it into the page's own repo if a CSP forbids the cross-origin script tag;
it has no imports.

---

## Verified 2026-08-16 (live, production)

All four real states, end to end, against the deployed functions:

| check | result |
|---|---|
| POST with no secret | `401 {"error":"bad secret"}` |
| POST missing `question_url` | `400` naming `no_link_surface` |
| status with a wrong token | `401 {"error":"bad token"}` |
| full escalation | key minted, `mac_command_id 80` |
| status t+1s | `filing` — "Sending this to Mike now." |
| status t+13s | `waiting`, `card_id d5e4f538-…` — bridge filed it in ~3s |
| card on the board | `type action`, `created_by dplus-reader-ai`, `dedupe_key mark-qa-…`, title 48 chars, `step_actions[0].command open_url` |
| after `pulse-push resolve` | `answered`, `human_reply` = Mike's note verbatim |
| deliberately malformed intent | `failed` — "This question did NOT reach Mike… nobody is waiting on it." |

Both test cards were resolved; no open `dplus-reader-ai` cards remain.

## Where the pieces live

| piece | file |
|---|---|
| escalate endpoint | `netlify/functions/escalate-question.js` |
| status endpoint | `netlify/functions/escalation-status.js` |
| browser client | `public/escalation/escalation-client.js` |
| card writer | `pulse-mac-bridge/bridge.py :: escalate_question` |
| contract | `pulse-zero/bin/pulse_card_contract.py` (unchanged — this rides it) |
