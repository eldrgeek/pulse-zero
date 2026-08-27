# Named Pulse addressees

Routing metadata on Mike's Pulse Zero board. Not a second board, not a
second owner login, not a second Discord bot, not a HUD.

Rook is the first named Grok Bot seat. Default addressee remains Mike.

## What rides the existing path

```
pulse-push <type> … --to rook
        │
        ▼
payload.addressee = "rook"     # omitted --to → field left off → implicit mike
        │
        ▼
pulse_card_contract.validate_payload()   # rejects unknown / Herm-profile names
        │
        ▼
POST public.pulse_cards                  # same table, same RLS, same Mike gate
```

`--source` / `created_by` is still **who posted**. `--to` / `payload.addressee`
is **who should act**. Do not overload provenance as the addressee.

The owner gate is unchanged: `public.is_pulse_owner()` is Mike only
(`mw@mike-wolf.com`, `mw.personalmail@gmail.com`). A Rook-addressed card
still lands on Mike's board because he is the human who sees Pulse. The
board UI shows a `to rook` badge so he can tell it is not his to execute.
The badge is fail-closed: it renders only for a known non-Mike seat
(Rook). An unknown slug does not get a seat badge — a typo `--to` must
not look like a real seat. `validate_payload()` already rejects unknowns
on write; the board still consults the same registry names
(`bin/pulse_seats.py` `SEATS`, mirrored as `KNOWN_SEATS` in
`public/index.html`) if a row reaches the renderer anyway.

Asks still go `cc hud-ask → relay :3333 → Pulse :8088`. No second HUD.

## Seat registry

Source of truth: [`bin/pulse_seats.py`](bin/pulse_seats.py).

| name | kind | inbox | discord.user_id | notes |
|---|---|---|---|---|
| `mike` | `human` | `pulse` | — | default; field omitted means this |
| `rook` | `grok-bot` | `pulse` | **unset** | Cursor Grok Bot seat, not a Herm profile |

Kinds are `human` | `grok-bot` only. Herm profiles (Rally / Mae / Greta) are
rejected by name — they are a different identity plane (NousResearch
hermes-agent / Herm). Do not collapse them into this registry.

Adding a seat later is a registry edit in this file, then a contract test.
Do not invent a Discord id to make a seat "complete."

## Discord delivery — stay Pulse-only until Herm is up

Verified 2026-08-26 on Mike's Mac:

- Away-from-Mac path is Discord, not Slack. Grok Bot has no Discord connector.
- Existing bot is Herm. Do **not** create a second bot, webhook, or Herm fork.
- `cc-dispatch` notify already POSTs to Discord channel `1312588771681636409`
  (Herm home) via cred-broker mint of `DISCORD_BOT_TOKEN`.
- `DISCORD_WEBHOOK_URL` is unset.
- Herm gateway `ai.hermes.gateway` is **not** bootstrapped (last Discord
  state 2026-08-11 failed to reconnect).
- `DISCORD_ALLOWED_USERS` is only Mike `567412518042206295`.
- Rook has **no** Discord user/bot/channel ID anywhere. This repo will not
  invent one.
- `channel_aliases.json` is missing.

**Decision for this PR:** a Rook-addressed card is Pulse-only. The seat
records Herm home as the *intended* future `discord.channel_id` (the
channel notify already dumps into) and leaves `discord.user_id` unset.
`pulse_seats.discord_mention_ready(rook)` is false. Missing Herm / missing
Rook Discord identity is not a contract violation and does not block
`--to rook` from landing on the board.

### Follow-up in cc-dispatch (not this repo)

Do **not** silently change `notify.sh` from here. Today's notify is an
unaddressed dump into channel `1312588771681636409`. A follow-up in
cc-dispatch may:

1. Read `payload.addressee` (or an explicit `--to` forwarded by the
   producer). Treat omitted as `mike`.
2. Look up the seat. If `discord.user_id` is set, mention that user in
   `discord.channel_id` (or the existing Herm home channel) using the
   **existing** Herm bot token. Thread if Discord already has a thread
   for that card; otherwise a mention in the same channel is enough.
3. If `discord.user_id` is missing (Rook today), **skip the mention**.
   Do not dump `@unknown`. The card is already on Pulse.
4. Do not create a second bot, webhook, HUD, or morning digest. Do not
   mention Herm profiles as if they were Grok Bot seats.

Until that follow-up, notify remains a dump. Pulse Zero's contract is
the field + registry; cc-dispatch owns the send.

## CLI

```bash
bin/pulse-push action --title "Review the PR" --url "https://…" --source skip --to rook --key "…"
bin/pulse-push action --title "Approve X" --url "https://…" --source dee          # implicit mike
bin/pulse-push action --title "Approve X" --url "https://…" --source dee --to mike  # explicit mike
```

Unknown `--to` and Herm profile names (`rally` / `mae` / `greta`) are a
hard `CardContractError`. Tests cover this without a live Discord or Herm
gateway.
