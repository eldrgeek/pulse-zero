# Pulse Zero — Adversarial Live-Surface UX Review

**Date:** 2026-08-14. **Reviewer:** Dee (Claude Fable 5, CCc), live-surface lane of a 3-lane adversarial
review ordered by Mike. **Method:** Playwright (Chromium) driving the deployed
`https://pulse-zero.netlify.app`, authenticated via the same admin-generated-magic-link technique as
`bin/test-board.py` (service key from Keychain `PULSE_ZERO_SERVICE_KEY`). Primary pass at Mike's real
device geometry — **412×915, mobile emulation, touch, Pixel 7 UA** — then a secondary 1280×800 desktop
pass. No code was changed. Every state-mutating test used disposable cards pushed with
`--source ux-review-*`, deleted immediately after; **zero real open cards were touched** (verified: the
one live card whose coordinates a race-condition test grazed, "Mint KeyDrop's own Netlify token",
was re-queried after the test and confirmed still `status=open`, `answer=null`).

Screenshots referenced below are at `~/Projects/pulse-zero/review/shots/<name>.png`.

---

## BLOCKS-MIKE

### 1. The global Feedback chip physically covers card action buttons — confirmed live, reproduces on first load, no scrolling needed

The `soma-feedback` widget (`position: fixed`, `z-index: 9999`, `bottom: 82px`, `left: 8px`) has **no
reserved gutter in the card list**. Whenever a card's button row lands in the viewport's bottom-left
~45px band — which happens on the very first screenful, every session, because the board's second card
is an action card — the black "Feedback" pill renders **on top of and fully occluding the card's
`Snooze` button**. On a phone Mike cannot see or tap `Snooze` on that card at all.

- **Repro:** open the board at 412×915, do not scroll. The second card ("Mint KeyDrop's own Netlify
  token…") has its `Snooze` button replaced on-screen by the Feedback chip.
- **Evidence (`getBoundingClientRect`, real scroll position, non-stitched screenshot):**
  `feedback root = {x:8, y:789, w:99.8, h:44}` vs. `Snooze button = {top:787, bottom:824, left:29,
  right:110}` — full rectangular overlap, feedback wins (`z-index:9999` beats the card's implicit
  stacking).
- **Screenshots:** `11-mobile-viewport-scroll0.png` (single real viewport, not full-page — the collision
  is real, not a screenshot-stitching artifact), `27-decision-other-dialog.png` (same collision recurs
  lower on the page against a different card, confirming it's positional/systemic, not a one-off).
- **Note on methodology:** I initially suspected the "Talk to Pulse" bar's similar mid-page appearance
  in full-page screenshots was the same kind of bug; verified with a direct viewport screenshot + DOM
  check and it is **not** — `#talk-bar` is correctly fixed-bottom and `main{padding-bottom:96px}`
  correctly reserves space for it. Only the Feedback chip lacks that reservation. Ruled out, not reported.
- **Smallest fix:** give the card list the same treatment already used for the talk bar — reserve
  ~60px of bottom padding/margin on the last card (or globally), or move the chip fully out of the
  card-content collision zone (bottom-right, or push it above `#talk-bar` by a margin that also clears
  card content, not just the talk bar).

### 2. A single long URL/token in card body text breaks the page's horizontal layout — clips text unreadable at 412px, no auto-linking

Any `--why` / `--steps` / `--full_text` containing an unbroken string longer than roughly the card
width (a deploy URL, a GitHub link, a hash) is rendered as **plain, un-linked text** with no
`overflow-wrap`/`word-break` applied (that CSS rule exists only on `a.link`, `index.html:79` — plain
body paragraphs get nothing). The result: the whole page gets pushed wider than the viewport and the
tail of the URL is clipped off-screen.

- **Repro:** pushed a disposable action card with `--why` containing one ~110-char URL mid-sentence.
- **Evidence:** `document.documentElement.scrollWidth = 582` vs. `clientWidth = 412` (170px of page-wide
  horizontal overflow) on the live board, directly attributable to that one card. `card.querySelectorAll('a')`
  returned zero anchors — the URL is not a link at all, just clipped text.
- **Screenshots:** `18-content-stress-action.png`, `20-content-stress-decision.png` (URL visibly cut off
  at the right edge, "...that/should/eithe" mid-word).
- **Smallest fix:** two independent, both cheap: (a) auto-linkify `https?://\S+` in rendered why/steps/
  lines/full_text; (b) regardless of (a), apply `overflow-wrap: anywhere` to the card body text classes
  as a blanket safety net so no single unbreakable token can ever widen the page again.

### 3. Zero offline resilience — a reload while offline hands the whole board off to the browser's blank error page, no cache, no "stale" indicator

Pulse Zero ships no `<link rel="manifest">`, no `serviceWorker.register(...)` anywhere in
`public/index.html` (grepped, zero hits), and its only JS dependency is loaded from a CDN
(`cdn.jsdelivr.net/npm/@supabase/supabase-js@2`) with no local fallback. This is realistic for the
actual use case: Mike reads this board on a phone, and elevators/subways/weak-signal moments are
exactly when he'd reach for it.

- **Repro:** log in, load the board successfully (warm), go offline, reload the same tab.
- **Evidence:** the top-level navigation itself fails (`net::ERR_INTERNET_DISCONNECTED`); both card
  fetches were aborted (`net::ERR_ABORTED` on the two `pulse_cards?...` REST calls). No cached shell, no
  cached card data, no in-app "you're offline, showing board as of Xm ago" message — the tab goes to the
  browser's native no-connection interstitial with **zero** of Mike's cards visible.
- **Screenshots:** `10-mobile-offline-reload.png`, `13-mobile-offline-samestab-reload.png`.
- **Smallest fix:** a minimal service worker that (a) cache-first-serves the static app shell (HTML/CSS/
  JS, including a locally-vendored copy of supabase-js instead of the bare CDN `<script>`), and (b)
  caches the last successful `pulse_cards` response so a reload-while-offline shows the last-known board
  with a visible "offline — last synced Xm ago" banner instead of nothing.

---

## DEGRADES

### 4. Markdown syntax renders completely literally in card body text

Confirmed live on ACTION and DECISION `--why` and on a BRIEF's `--lines`: `**bold**`, `_emphasis_`, and
`` `code` `` all render as raw asterisks/underscores/backticks, verbatim, in front of Mike. There is no
markdown processing anywhere in the renderer (`esc()` just HTML-escapes; nothing un-escapes `**`/`_`/`` ` ``).
Given nearly every doc in this codebase is markdown-authored, any producer who copies a paragraph out of
a markdown source into `--why`/`--lines`/`--full-text` will paint literal punctuation.
- **Screenshots:** `18-content-stress-action.png`, `20-content-stress-decision.png`.
- **Smallest fix:** pick one — either strip common markdown syntax at the contract layer with a warning
  (cheapest), or render the narrow safe subset (bold/italic/code/auto-links) client-side. Either beats
  today's "neither."

### 5. Most primary buttons measure 37px tall, under the 44px touch-target floor; the sole feedback-thread entry point measures 16px

A live sweep of every `<button>`/`<a>` on the loaded board at 412×915 found 82 of 85 interactive
elements under 44px in at least one dimension, including **every** `Open`/`Preview`/`Ask Pulse`/`Done`/
`Snooze`/`Not mine`/`Ack` button on every card (all measured `h=37px`). Worse: `.comment-toggle` — the
"Pulse thread (N)" / "Comment or give feedback" button, the **only** way to reach the per-card comment
thread the README calls a mandatory, always-present affordance — is styled as a bare underlined text
link (`background:none; border:none; padding:0`, `index.html:204`) and measures **16px tall**.
- **Smallest fix:** bump `.btn-primary`/`.btn-secondary` vertical padding to clear 44px min-height (a
  CSS-only change, same pattern the drill-toggle/drill-pin buttons already use correctly per the
  2026-08-13 accordion pass); give `.comment-toggle` real button padding instead of link styling.

### 6. The plain Done/Ack/Bounce path has no double-submit guard (the typed-actions path does)

`answerCard()` (`index.html:1478`) fires its `sb.from('pulse_cards').update(...)` with no synchronous
`button.disabled = true` beforehand — unlike the typed-action execution paths (`index.html:683, 920,
1073`), which all disable their button before awaiting. A rapid double-tap on `Done` sends two
redundant network writes. Tested live with two clicks 60ms apart: the DB ended up consistent (single
row, single `answer` object) because the PATCH happens to be idempotent for a same-card double-tap —
but the guard the codebase already knows how to write elsewhere is simply absent on the path Mike uses
most (every ordinary card close).
- **Smallest fix:** `button.disabled = true` synchronously at the top of the click handler, mirroring
  the already-correct typed-action pattern.

### 7. Decision cards silently drop options past 4, with zero on-card signal to Mike

`pulse_card_contract.py` only *warns* (stderr, fleet-only) when a decision has more than 4 options;
the board hard-slices to the first 4. Live-confirmed: pushed a 6-option decision (`Alpha, Beta, Gamma,
Delta, Epsilon, Other`) — the rendered card shows `Alpha, Beta, Gamma, Delta, Other` and **silently
drops "Epsilon"**. Mike has no way to know a real choice is missing unless he already expected it.
- **Screenshot:** `26-decision-6options.png`.
- **Smallest fix:** render an inline "+N more — ask in thread" affordance whenever
  `payload.options.length > 4`, so the truncation is visible on the card, not just in a log Mike never sees.

### 8. Preview's embed-refusal detection has a dead timing zone — confirmed against a real card's real target URL

`togglePreview()` (`index.html:1104-1127`) only flags "Site refuses embedding" if the iframe's `load`
event fires in <150ms (implausibly fast) or doesn't fire within 2500ms. A real X-Frame-Options block
whose `load` fires at a normal in-between delay (a real cross-origin round trip before the browser
blocks rendering) satisfies neither condition and the iframe just sits blank forever.
- **Repro:** tapped `Preview` on the live "Mint KeyDrop's own Netlify token" card (target:
  `app.netlify.com`, read-only, no state change). Waited 3.2s — plain empty bordered box, no fallback
  note ever appeared.
- **Screenshot:** `28-preview-embed-result.png`.
- **Smallest fix:** after `load` fires, also check the rendered iframe height stays 0/near-0 for a beat,
  or best-effort read `contentWindow.location.href` (readable if actually about:blank) as a second
  signal; treat either as blocked, not just the two timing extremes.

### 9. No per-card deep link exists — confirmed against the live surface, matches an already-open spec gap

`location.hash`/`location.search` stayed empty through every interaction I drove (drill-open, pin,
comment, answer). Grepped `public/index.html` for any hash/query-based routing — none exists. This is
already named as an open item in `SOMA/specs/handshake-protocol-v1.md` ("R2 — verify Pulse exposes a
per-card deep link; if not, add one") — this pass confirms, live, that it's still absent.
- **Smallest fix:** as the spec already prescribes — `?card=<id>` (or a hash route) that scrolls to and
  highlights the matching card on load; have `pulse-push` emit the resulting URL at write time.

### 10. Adjacent system, not pulse-zero itself, but the exact "`?` title" bug shape Mike named

`_estate/bin/pulse-answer-write` (lines 97 and 148) derives a verdict card's title with
`p.get("title") or p.get("question") or p.get("artifact") or "?"` — but the contract field for a
verdict's name is `artifact_name` (`pulse_card_contract.py` `REQUIRED_FIELDS["verdict"]`), never
`artifact`. Every verdict card that flows through the session-start "open asks" feed
(`session-start-open-asks.sh` → `pulse-answer-write --list`, which every Claude session sees at
SessionStart) therefore renders title `"?"` — exactly the shape Mike quoted (`befa45eb [verdict] ?`).
Confirmed by direct code read; **not** reproduced live on the board itself because no open verdict card
exists right now (pulse-zero's own renderer, `cardTitleText()` in `public/index.html:360-362`, correctly
checks `p.artifact_name` and has a sane `'Untitled card'` fallback — this bug is isolated to the
`_estate` feed script, out of pulse-zero's own scope but part of the same board ecosystem).
- **Smallest fix:** one-word change at both call sites, `p.get("artifact")` → `p.get("artifact_name")`.

---

## COSMETIC

### 11. Comment/reply box is a single-line `<input>`, not a `<textarea>`
`index.html:1270`, `class="textresp comment-input"` — fine for a short ack, cramped for anything longer.

### 12. `min-height: 100vh` (not `100dvh`) on `body`/`.login` (`index.html:16, 221`)
The classic mobile-address-bar tell. Low current impact only because there's no manifest/service worker
for a standalone/installed mode to begin with (see Finding 3) — the page always runs inside browser
chrome, which is exactly where this bites hardest as Chrome's toolbar shows/hides on scroll.

### 13. "Talk to Pulse" ambient-voice row is visually indistinguishable from an ordinary card
It's correctly a fixed-bottom bar (`#talk-bar`) at real scroll positions, not a real bug — but its
in-flow-card-styled first-paint appearance (before scroll) reads like just another card in the queue,
easy to skim past or mistake for something stalled.

---

## What was checked and passed (for calibration, not padding)

- **Drill-down pin (touch):** tapping the 📌 on a Steps drill correctly sets `aria-pressed`, and a
  second drill opened afterward correctly leaves the first (pinned) one open too
  (`multi-drill-open-count: 2`) — matches the documented 2026-08-13 contract.
- **Answered-card hides correctly:** a cleanly single-clicked test card left the DOM entirely
  within ~2s, no reload needed, no leak into the default view; verified all 15 live `.card.answered`
  elements sit inside the collapsed `Recently done` `<details>`, none leak into the open 8.
- **No real card was corrupted** by the double-tap race test — re-verified via direct REST query after
  the test.
- **Horizontal overflow (generic sweep):** zero DOM elements report `right > viewport width` on the
  real, unmodified live board content as of this review (the URL-overflow bug in Finding 2 only
  reproduces with body text long/unbroken enough to trigger it — today's real cards happen not to
  contain one, but nothing prevents a future one from doing so).
- **Throttled load (500kbps/400ms latency emulated):** DOM content painted at 1.3s, cards populated
  and readable at 2.4s — acceptable, not a finding.
- **No literal markdown/unlinked-URL leakage on today's real card set** — the bugs in Findings 2 and 4
  are payload-triggered, not currently present in the live board's actual content.
