#!/usr/bin/env python3
"""Pulse Zero board cleanup, 2026-08-11.

Every open card except one violated the board contract the estate wrote for
itself: 8 of 9 written by pulse-drain (escalator) with dedupe_key=NULL, a
"⏫ Day N — still waiting: " banner concatenated into the stored title (two of
them truncated mid-word), and no typed actions. Because the escalator retires
yesterday's card and inserts a fresh key-less clone every morning, one request
has produced 3-5 rows apiece across the 86 retired cards, and Mark's Tailscale
question was occupying three separate open cards under three framings.

This restores the DATA to the contract. The escalator CODE is held by a
concurrent session tonight and is untouched here.
"""
import json, os, sys, urllib.request, urllib.error

sys.path.insert(0, "/Users/mikewolf/Projects/pulse-zero/bin")
from pulse_card_contract import validate_payload, CardContractError, TITLE_MAX

KEY = os.environ["PULSE_ZERO_SERVICE_KEY"]
BASE = "https://omfwcodoimjmbrhssvfl.supabase.co/rest/v1/pulse_cards"
H = {"apikey": KEY, "Authorization": "Bearer " + KEY,
     "Content-Type": "application/json", "Prefer": "return=representation"}
DRY = "--apply" not in sys.argv


def req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=H, method=method)
    with urllib.request.urlopen(r) as resp:
        raw = resp.read().decode()
    return json.loads(raw) if raw.strip() else []


def get(cid):
    rows = req("GET", f"{BASE}?id=eq.{cid}&select=*")
    return rows[0] if rows else None


# ── The Mark/Tailscale consolidation ────────────────────────────────
MARK_WHY = (
    "Mark (mark@inarai.com) tried SSH to the VPS on 07-31 and got connection-reset: "
    "public :22 has been Tailscale-only since the 07-23 post-compromise hardening, so "
    "the command in our 07-30 email could never have succeeded as sent. Dee told him a "
    "firewall exception needs your sign-off given the box's breach history.\n\n"
    "His reply (msg #532) went further than an access request: he is \"strongly opposed "
    "to using tailscale anywhere in our DPlus design\" — calls it added expense, a "
    "dependency, and a vulnerability, wants an internet-reachable relay rather than "
    "peer-to-peer, and says \"there is a good chance there is no point going forward "
    "with my access.\" So this is one question, not two: whether to open VPS access at "
    "all is now entangled with whether Tailscale survives in the DPlus transport design.\n\n"
    "Loose end worth a look either way: his DNS resolved to 149.248.211.216, which is "
    "neither of our known VPS addresses (217.77.6.197 public / 100.82.118.85 tailscale).\n\n"
    "Consolidated 2026-08-11 from three open cards asking this same question under three "
    "framings (veep-mark-ssh-external-access-20260730 07-31, "
    "mark-dplus-tailscale-objection-2026-07-31 07-31, and this one 08-07). The other two "
    "are resolved and point here."
)

MARK_OPTIONS = [
    "Open a scoped firewall exception for Mark's IP on :22",
    "Add Mark to Tailscale anyway (he's opposed)",
    "Stand up a separate public relay/port for DPlus per Mark's ask",
    "Table his VPS sandbox access — not worth it right now",
]

# id -> (new payload fields to merge, new dedupe_key)
RETITLE = {
    # Genuinely Mike's: a product-scope + publishing call on his Google account.
    "e29c2d39-083e-431f-a6a4-9173b57620fa": (
        {"title": "Decide: publish the Docs add-on or keep it per-document"},
        "playmaker-gdocs-addon-install",
    ),
    # Genuinely Mike's: generates a private identity keypair on his machine and
    # involves an external human (Daniel).
    "914b0eb7-7ee4-4a43-8ba4-5fdf0b5816b4": (
        {"title": "Set up Buzz + join Daniel's wolfcraft-ai community"},
        "buzz-daniel-invite-setup",
    ),
    # Genuinely Mike's: creating a real Stripe account under his identity, money.
    "86ff3f2c-5b7e-4c95-82bb-84f876f8cea7": (
        {"title": "Connect real Stripe account to SOMA-Relay donations"},
        "connect-soma-relay-stripe",
    ),
    # The survivor of the three Mark cards.
    "0312b7aa-66fb-4086-9284-b607740994f6": (
        {"question": "Decide Mark's VPS access now he's rejected Tailscale",
         "why": MARK_WHY,
         "options": MARK_OPTIONS,
         "url": "https://github.com/InaraiLLC/dplus"},
        "mark-tailscale-dealbreaker-2026-08-07",
    ),
}

# id -> (new status, note)
CLOSE = {
    # ALREADY DONE. Card created 2026-07-31T14:49Z; FIELDY_API_KEY was written to
    # the login Keychain at 2026-07-31T16:08Z (`security find-generic-password -s
    # FIELDY_API_KEY` -> cdat 20260731160824Z), and `fieldy auth --from-clipboard`
    # verifies against GET /user/me before storing. Mike did this 79 minutes after
    # being asked. Nothing closed the card, so it has escalated for 3 days.
    "32c47b10-ca81-4024-9022-4b854d99255f": (
        "resolved",
        "Already done 2026-07-31. FIELDY_API_KEY is in the login Keychain "
        "(created 20260731160824Z, 79 min after this card was pushed) and "
        "`fieldy auth` verifies against GET /user/me before storing, so the key "
        "is known-good. The card was never closed and escalated 3 days for "
        "nothing. Closed by the 2026-08-11 board cleanup.",
    ),
    "a30f6cfe-dd13-4c75-b40e-b61307fa57b1": (
        "resolved",
        "Consolidated into card 0312b7aa (key mark-tailscale-dealbreaker-2026-08-07), "
        "which asks the same question with the complete 4-option list and now carries "
        "this card's DNS finding (149.248.211.216). Three open cards were asking Mike "
        "one question. Closed by the 2026-08-11 board cleanup.",
    ),
    "18dc1566-52d9-4deb-b335-2a1d5dfe4288": (
        "resolved",
        "Consolidated into card 0312b7aa (key mark-tailscale-dealbreaker-2026-08-07), "
        "which asks the same question with the complete 4-option list and now carries "
        "this card's DPlus repo link. Three open cards were asking Mike one question. "
        "Closed by the 2026-08-11 board cleanup.",
    ),
    # FAILS THE MIKE-GATE TEST. A non-deterministic launchd/cc-dispatch bug is
    # engineering work: no privilege Mike holds, no taste call, no external human,
    # no fingertip. It is the poster's own job.
    "d3595ff5-e1fa-4d73-8d97-9d64c2c9c94f": (
        "bounced",
        "You know what to do, don't you? — Not Mike-gated. "
        "mark-email-watch calling zero tools on ~76% of launchd runs is a "
        "non-deterministic dispatch bug in cc-dispatch: no privilege Mike holds, no "
        "consent or taste call, no external human, nothing that needs a fingertip. "
        "Diagnosing and fixing it is the poster's own job. Bounced by the 2026-08-11 "
        "board cleanup; the finding itself is real and stays on the work queue.",
    ),
}


def main():
    print("MODE:", "DRY RUN (pass --apply to write)" if DRY else "APPLYING")
    problems = 0

    print("\n── retitle + restore stable keys ──")
    for cid, (fields, dkey) in RETITLE.items():
        c = get(cid)
        if not c:
            print(f"  !! {cid[:8]} not found"); problems += 1; continue
        if c["status"] != "open":
            print(f"  -- {cid[:8]} is {c['status']}, skipping (idempotent)"); continue
        p = dict(c["payload"] or {})
        p.update(fields)
        try:
            warns = validate_payload(c["type"], p, title_max=TITLE_MAX)
        except CardContractError as e:
            print(f"  !! {cid[:8]} CONTRACT VIOLATION: {e}"); problems += 1; continue
        shown = p.get("title") or p.get("question")
        print(f"  ok {cid[:8]} {c['type']:8} key={dkey}")
        print(f"       title({len(shown)}): {shown!r}")
        if warns:
            for w in warns:
                print(f"       warn: {w}")
        if not DRY:
            req("PATCH", f"{BASE}?id=eq.{cid}",
                {"payload": p, "dedupe_key": dkey})

    print("\n── close: resolve / bounce ──")
    for cid, (status, note) in CLOSE.items():
        c = get(cid)
        if not c:
            print(f"  !! {cid[:8]} not found"); problems += 1; continue
        if c["status"] != "open":
            print(f"  -- {cid[:8]} already {c['status']}, skipping (idempotent)"); continue
        field = "resolved_note" if status == "resolved" else "bounce_reason"
        print(f"  ok {cid[:8]} -> {status}: {note[:80]}...")
        if not DRY:
            req("PATCH", f"{BASE}?id=eq.{cid}", {"status": status, field: note})

    print("\nproblems:", problems)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
