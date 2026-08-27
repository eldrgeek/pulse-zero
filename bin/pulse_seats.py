"""Named Pulse addressees — seat registry, not a second owner login.

SCOPE (2026-08-27). Pulse Zero cards had no addressee field. Provenance
(``created_by`` / ``--source``) is who posted, not who should act. This
module is the small registry that lets ``--to rook`` ride the existing
card contract and ``pulse-push`` without a new transport, HUD, bot, or
owner identity.

The board stays Mike-gated: he is the human who sees Pulse
(``mw@mike-wolf.com``, ``mw.personalmail@gmail.com``). Addressee is
routing metadata on that one board. Default addressee is Mike. Omitted
``payload.addressee`` means Mike.

Seats here are Grok Bot seats (Cursor agents) plus the default human.
They are NOT Herm profiles (Rally / Mae / Greta). Do not collapse those
identities into this registry, and do not invent a Discord user/bot/
channel id for a seat that does not have one recorded.

Inbox is Pulse for every seat. Discord is optional and currently not
mention-ready for Rook (no Discord identity anywhere; Herm gateway
``ai.hermes.gateway`` is not bootstrapped). Live Discord delivery stays
with cc-dispatch ``notify`` — see ``ADDRESSEES.md``. This module does
not POST anywhere.

This module is deliberately pure: no I/O, no argparse, no network.
"""

DEFAULT_ADDRESSEE = "mike"

# Herm profiles are a different identity plane (NousResearch hermes-agent).
# Naming one as a Pulse addressee is a contract violation, not an alias.
HERM_PROFILES = frozenset({"rally", "mae", "greta"})

# Optional discord target shape: {channel_id, user_id}. Mention-ready only
# when user_id is a real recorded id. Rook's is unset on purpose.
#
# Board lockstep: public/index.html ``KNOWN_SEATS`` must list these same
# slugs. The renderer cannot import this module; it badges only a known
# non-Mike seat and fail-closes (omits the badge) on anything else. Adding
# a seat here without updating KNOWN_SEATS would hide a valid badge.
SEATS = {
    "mike": {
        "name": "mike",
        "display_name": "Mike",
        "kind": "human",
        "inbox": "pulse",
        # Owner of the board. He sees every card; Discord mention is not
        # how his asks arrive.
        "discord": None,
    },
    "rook": {
        "name": "rook",
        "display_name": "Rook",
        # Cursor Grok Bot seat — not a Herm profile.
        "kind": "grok-bot",
        "inbox": "pulse",
        # Intended future notify channel is Herm home (cc-dispatch already
        # dumps there). user_id is unknown — do not invent one. Until it
        # is recorded here AND Herm is up, Rook-addressed cards are
        # Pulse-only.
        "discord": {
            "channel_id": "1312588771681636409",
            "user_id": None,
        },
    },
}

SEAT_KINDS = frozenset({"human", "grok-bot"})


class SeatError(ValueError):
    """Unknown or disallowed addressee. ``rule`` is stable for tests."""

    def __init__(self, rule, message, hint=None):
        self.rule = rule
        self.message = message
        self.hint = hint
        super().__init__(message)


def normalize_seat_name(name):
    if name is None:
        return None
    if not isinstance(name, str):
        raise SeatError(
            "field_type",
            f"addressee must be a string, got {type(name).__name__}",
        )
    slug = name.strip().lower()
    return slug or None


def get_seat(name):
    """Look up a seat by name. ``None``/blank is the default (Mike).

    Raises :class:`SeatError` for Herm profiles and unknown names.
    """
    slug = normalize_seat_name(name)
    if slug is None:
        return SEATS[DEFAULT_ADDRESSEE]
    if slug in HERM_PROFILES:
        raise SeatError(
            "herm_profile_not_a_seat",
            f"{name!r} is a Herm profile, not a Grok Bot seat",
            hint=(
                "Rally/Mae/Greta live on Herm. Named Pulse addressees are "
                f"grok-bot seats (currently: rook) plus the default human "
                f"({DEFAULT_ADDRESSEE}). Do not collapse those identities."
            ),
        )
    seat = SEATS.get(slug)
    if seat is None:
        known = ", ".join(sorted(SEATS))
        raise SeatError(
            "unknown_addressee",
            f"{name!r} is not a named Pulse seat (known: {known})",
            hint=(
                "Addressee is routing metadata on Mike's board, not a "
                "second owner login. Default is mike. Pass --to rook for "
                "the first grok-bot seat."
            ),
        )
    return seat


def effective_addressee(payload):
    """Canonical addressee slug for a board payload. Missing → mike."""
    raw = None if payload is None else payload.get("addressee")
    return get_seat(raw)["name"]


def discord_mention_ready(seat):
    """True only when a real Discord user_id is recorded. Rook is not."""
    discord = (seat or {}).get("discord") or {}
    user_id = discord.get("user_id")
    return isinstance(user_id, str) and bool(user_id.strip())


def stamp_addressee(payload, to_arg):
    """Write ``payload.addressee`` only when ``--to`` is provided.

    Omitted/blank leaves the field off the payload (implicit Mike). The
    contract canonicalizes and rejects unknowns; this function does not
    POST, mention, or talk to Discord.
    """
    slug = normalize_seat_name(to_arg)
    if slug is None:
        return payload
    payload["addressee"] = slug
    return payload


def list_seats():
    """Stable copy of the registry for tests and docs."""
    return {name: dict(seat) for name, seat in SEATS.items()}
