"""pulse_card_contract — the Pulse Zero card contract as data + pure validators.

SCOPE — what this module governs, stated exactly (2026-08-01). It governs the
Supabase table ``public.pulse_cards`` WHERE ``app_id = 'pulse-zero'`` — Mike's
Pulse Zero board. Callers verified by grepping every ``POST pulse_cards`` under
``~/Projects``:

  CALLS THIS MODULE TODAY
  • ``pulse-zero/bin/pulse-push``      — ``enforce_contract()`` in ``push()``,
    on every card type, before any network call.
  • ``_estate/bin/pulse_common.push_card()`` — the write primitive for the two
    launchd producers, ``_estate/bin/pulse-morning`` and
    ``_estate/bin/pulse-drain``.
  • ``_estate/bin/pulse-enqueue``      — does NOT write to ``pulse_cards``; it
    writes a queue line that ``pulse-morning`` later drains. It calls
    ``validate_payload()`` on the payload that line will *become*, via
    ``pulse_common.queue_item_payload()``, so rejection happens at enqueue time
    while someone is watching rather than at 6am with no audience.
  • ``_estate/bin/tower-watchdog.sh``  — indirectly; it shells out to
    ``pulse-push brief``.

  DOES NOT CALL THIS MODULE, and does not need to
  • ``pulse-zero/bin/test-board.py``   — a test fixture that deliberately
    writes malformed rows to exercise the renderer.
  • ``pulse-zero/public/index.html``   — PATCHes status/answer only; never
    inserts.
  • ``_estate/bin/pulse-archive`` / ``pulse-answer`` — read-only with respect
    to ``pulse_cards`` (they import ``pulse_common`` but never ``push_card``).

  NOT THIS TABLE — name collision, do not be fooled
  • ``Sidekick-android/server/index.js`` has its own local ``pulse_cards``
    table with a completely different schema (``state``/``card_json``, no
    ``app_id``). Unrelated to this board and out of scope.

Before this module existed only ``pulse-push`` enforced anything. Any session
that found ``pulse-enqueue`` first bypassed the entire contract without knowing
it did, and ``push_card()`` was a bare POST — so two scheduled nightly jobs
could put rows on the board that ``pulse-push`` would have rejected outright.

This module is deliberately pure: no I/O, no ``sys.exit``, no argparse
coupling. Hard failures raise :class:`CardContractError`; soft issues come back
as a list of warning strings the caller prints to stderr and then proceeds.

Layer note (this trips people up): the *board payload* key for a verdict's name
is ``artifact_name``, but the ``pulse-push`` CLI flag that sets it is
``--artifact``, and the ``pulse-queue.jsonl`` line that ``pulse-morning`` drains
stores it as ``title``. Three names, one field. This module validates the board
payload — the only layer the renderer and Mike actually see
(``pulse-zero/public/index.html`` renders ``p.artifact_name`` / ``p.summary``).

Board standard: ``~/Projects/pulse-zero/README.md``.
"""

README_REF = "~/Projects/pulse-zero/README.md"

# Action titles only. Decision questions are routinely longer than this on the
# live board (and pulse-push has never capped them), so the cap is NOT applied
# to question / artifact_name / brief title.
TITLE_MAX = 60

# The one documented per-producer override. _estate/bin/pulse-drain's nightly
# escalator deliberately re-titles a card it is re-surfacing as
# "⏫ Day N — still waiting: <original title>". That banner is a nudge, not an
# authored title, and it is intentionally longer than TITLE_MAX.
#
# It is bounded, not exempt. Derivation: the longest prefix
# "⏫ Day 10 — still waiting: " is 26 chars, and pulse-drain's card_title()
# truncates the original to 70, so the true ceiling is 96. 160 leaves headroom
# for a longer prefix without letting an unbounded string onto the board.
# Any producer needing a different cap passes title_max explicitly and
# documents why HERE — never by skipping validation.
ESCALATION_TITLE_MAX = 160

# Weak signal words that suggest a title is descriptive, not imperative
# ("Approve the deploy" is imperative; "Deploy approval needed" is not).
NON_IMPERATIVE_STARTS = (
    "the ", "a ", "an ", "this ", "there ", "it ", "i ", "we ",
)

CARD_TYPES = ("action", "decision", "verdict", "brief")

# Hard requirements, per card type, keyed by *board payload* field name.
# These mirror pulse-push's argparse `required=True` flags exactly — that was
# previously the only place the rules lived, which is why they could not simply
# be imported.
REQUIRED_FIELDS = {
    "action": ("title",),
    "decision": ("question", "options"),
    "verdict": ("artifact_name", "url", "summary"),
    "brief": ("title", "lines"),
}

# Everything else the payload may legitimately carry, per type.
OPTIONAL_FIELDS = {
    "action": ("why", "steps", "url", "step_actions", "actions", "actions_version",
               "escalation_day", "orig_key", "status_line"),
    "decision": ("why", "url", "escalation_day", "orig_key"),
    "verdict": ("why", "escalation_day", "orig_key"),
    # full_text (2026-08-13, Mike's roundup-copy fix): `lines` is the short,
    # always-visible digest (~2-second scan); `full_text` is the complete
    # fleet-record body, rendered behind a collapsed-by-default drill-down in
    # the board so the card itself never dumps the long form on Mike.
    "brief": ("escalation_day", "orig_key", "full_text"),
}

# Declared JSON type of each REQUIRED field, so a wrong type is a contract
# violation instead of a crash.
#
# Why this exists (2026-08-01): the differential fuzz that validated the DB tier
# (`test/gen_card_gate_fuzz.py`) found two failure classes. 168 payloads put a
# non-string in a text field and `validate_payload` accepted them silently. 72
# raised a raw `AttributeError`/`TypeError` — and that class is the dangerous
# one, because `pulse-drain` copies payloads from EXISTING rows and catches only
# `(CardContractError, SystemExit)`. One bad row inserted by any raw-REST writer
# therefore killed the entire nightly escalation loop mid-run rather than
# skipping a single card. Typing them here turns both classes into a
# `CardContractError` every caller already handles.
#
# Types are taken from what the board ACTUALLY stores across all 104 live rows,
# not from the README. Note `lines` is a newline-joined **str**, not a list —
# 21/21 brief cards store it that way, and declaring it a list would reject
# every brief card ever written.
REQUIRED_FIELD_TYPES = {
    "title": str,
    "question": str,
    "artifact_name": str,
    "summary": str,
    "url": str,
    "lines": str,
    "options": (list, tuple),
}

# payload field -> the pulse-push CLI flag that sets it, so an error can name
# both the contract field and the flag an author would reach for.
FLAG_FOR_FIELD = {
    "title": "--title",
    "question": "--question",
    "options": "--options",
    "artifact_name": "--artifact",
    "summary": "--summary",
    "lines": "--lines",
    "url": "--url",
    "why": "--why",
    "steps": "--steps",
}

# List-valued payload fields — "present" means non-empty, not merely not-None.
LIST_FIELDS = ("options",)


class CardContractError(ValueError):
    """A hard contract violation. ``rule`` is a stable machine-readable id."""

    def __init__(self, rule, message, hint=None):
        self.rule = rule
        self.message = message
        self.hint = hint
        super().__init__(message)

    def __str__(self):
        out = f"card contract violation [{self.rule}]: {self.message}"
        if self.hint:
            out += f"\n  {self.hint}"
        out += f"\n  Board standard: {README_REF}"
        return out


def is_present(value):
    """Contract-level presence: None, "", "   " and [] all count as missing."""
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict)):
        return len(value) > 0
    return True


def validate_field_types(card_type, payload):
    """Required fields must carry their declared JSON type.

    Only fields that are *present* are checked — absence is
    ``validate_required_fields``' job, and this must not second-guess it.
    Raises :class:`CardContractError` so callers that already handle the
    contract exception (notably ``pulse-drain``'s per-card try/except) skip one
    bad card instead of dying mid-loop on a raw ``TypeError``.
    """
    for field in REQUIRED_FIELDS.get(card_type, ()):
        expected = REQUIRED_FIELD_TYPES.get(field)
        if expected is None or field not in payload:
            continue
        value = payload[field]
        if value is None or isinstance(value, expected):
            continue
        names = expected if isinstance(expected, tuple) else (expected,)
        want = " or ".join(t.__name__ for t in names)
        flag = FLAG_FOR_FIELD.get(field, f"--{field}")
        raise CardContractError(
            "field_type",
            f"{card_type} card's {field} ({flag}) must be {want}, "
            f"got {type(value).__name__}",
            hint=(f"Value was {value!r}. A wrong type here renders as a blank or "
                  f"broken card rather than failing loudly at the author."),
        )


def validate_url_scheme(payload):
    """CODE#4 (2026-08-14): block any non-http(s) scheme on payload.url at the
    contract layer, not just the client render paths.

    Before this, ``url`` was type-checked (must be a string) but never
    scheme-checked — ``--url 'javascript:fetch(...).then(...)'`` passed
    ``validate_payload`` cleanly for action, verdict, and decision cards
    alike. The client-side render fix (``safeHttpUrl()`` gating every
    href/window.open/iframe.src in ``public/index.html``) closes the same
    hole downstream, but a hard gate belongs at the point of insertion too —
    an unvalidated row can still be read by any other consumer
    (``pulse-board-truth``, a future integration) that doesn't happen to
    scheme-check.
    """
    url = payload.get("url")
    if not is_present(url):
        return
    try:
        from urllib.parse import urlparse
        scheme = urlparse(url).scheme.lower()
    except Exception:
        scheme = ""
    if scheme not in ("http", "https"):
        raise CardContractError(
            "unsafe_url_scheme",
            f"url (--url) must be an http(s) URL, got scheme {scheme or '(none)'!r}",
            hint=(f"Value was {url!r}. A javascript:/data:/other-scheme URL "
                  f"here becomes a live code-execution path when Mike clicks "
                  f"it — this board only ever links to real web pages."),
        )


def validate_card_type(card_type):
    if card_type not in CARD_TYPES:
        raise CardContractError(
            "unknown_card_type",
            f"{card_type!r} is not a card type; must be one of {', '.join(CARD_TYPES)}",
        )
    return card_type


def validate_title(title, field="title", flag="--title", title_max=TITLE_MAX):
    """The action-title rule: required, non-blank, <= ``title_max`` chars.

    ``title_max`` defaults to the board standard. The only sanctioned override
    is ESCALATION_TITLE_MAX (see its comment). Raises on hard failure; returns
    a list of soft warning strings.
    """
    if not is_present(title):
        raise CardContractError(
            "required_field",
            f"{field} ({flag}) is required and cannot be blank",
        )
    if len(title) > title_max:
        raise CardContractError(
            "title_max_chars",
            f"{field} is {len(title)} chars, max is {title_max}",
            hint=(f"One imperative line, not an essay. Got: {title!r}\n"
                  f"  Trim it — put detail in --steps or --why instead."),
        )

    warnings = []
    stripped = title.strip().lower()
    if stripped.endswith("?"):
        warnings.append(
            f"{field} reads as a question, not an imperative: {title!r}\n"
            f"  Example of a passing title: 'Approve the Netlify deploy'"
        )
    elif any(stripped.startswith(w) for w in NON_IMPERATIVE_STARTS):
        warnings.append(
            f"{field} may not be imperative (starts with '{stripped.split()[0]}'): {title!r}\n"
            f"  Example of a passing title: 'Approve the Netlify deploy'"
        )
    return warnings


def validate_required_fields(card_type, payload):
    """Every REQUIRED_FIELDS entry for this type must be present."""
    missing = [f for f in REQUIRED_FIELDS[card_type] if not is_present((payload or {}).get(f))]
    if missing:
        named = ", ".join(f"{f} ({FLAG_FOR_FIELD.get(f, '--' + f)})" for f in missing)
        article = "An" if card_type[0] in "aeiou" else "A"
        raise CardContractError(
            "required_field",
            f"{card_type} card is missing required field(s): {named}",
            hint=(f"{article} {card_type} card requires: "
                  f"{', '.join(REQUIRED_FIELDS[card_type])}."),
        )


def validate_payload(card_type, payload, title_max=TITLE_MAX):
    """Validate a board payload against the contract for ``card_type``.

    The entry point for every caller listed under SCOPE at the top of this
    module: ``pulse-push`` directly, ``pulse_common.push_card()`` on behalf of
    ``pulse-morning`` and ``pulse-drain``, and ``pulse-enqueue`` on the payload
    its queue line will become.

    Raises :class:`CardContractError` on a hard violation; returns a list of
    soft warning strings (the caller prints them to stderr and continues).
    """
    validate_card_type(card_type)
    if payload is not None and not isinstance(payload, dict):
        raise CardContractError("payload_shape", "payload must be an object")
    if not payload:
        raise CardContractError(
            "empty_payload",
            f"{card_type} card has an empty payload — nothing would render",
        )

    validate_required_fields(card_type, payload)
    validate_field_types(card_type, payload)
    validate_url_scheme(payload)

    warnings = []
    if card_type == "action":
        warnings += validate_title(payload.get("title"), title_max=title_max)
        # Any step-action command is a real affordance, not just open_url.
        #
        # 2026-08-13 (Tower): this used to test `command == "open_url"` alone,
        # which made the gate reject cards whose button was BETTER than a link.
        # It silently broke the estate's own alarm of last resort. The
        # tower-watchdog "Tower is down — start it by hand" card carries a
        # consent-gated `open_session` button (opens a Claude Desktop task and
        # injects the respawn prompt on Mike's click). From the moment this
        # gate landed (7ad33ba, 07:56 EDT) every attempt to file that card
        # failed with no_link_surface — and because push_action_card redirects
        # all output to /tmp/tower-watchdog-pulse.log with `>`, the error was
        # invisible. Tower then died at 17:23Z and stayed dark 9.7h while the
        # watchdog correctly detected it, correctly refused an unsafe respawn,
        # and could not tell anyone. Mike found out by asking.
        #
        # The gate's intent is right: an action card must give Mike something
        # to DO. But `open_url`, `open_session`, `clipboard_set` and
        # `clipboard_take_and_deploy` are ALL things to do — they are exactly
        # the set this codebase already validates in STEP_ACTION_COMMANDS.
        # Recognising one of the four was a false negative, and a hardening
        # rule that disarms the safety net is worse than the prose it was
        # written to stop.
        STEP_LINK_COMMANDS = {
            "open_url", "open_session", "clipboard_set",
            "clipboard_take_and_deploy",
        }
        has_step_link = any(
            isinstance(a, dict) and a.get("command") in STEP_LINK_COMMANDS
            for a in (payload.get("step_actions") or [])
        )
        has_link_surface = is_present(payload.get("url")) or has_step_link \
            or bool(payload.get("actions"))
        if not has_link_surface:
            # HARD GATE (2026-08-13, Mike's ask). This used to be a warning
            # that every caller printed to stderr and ignored — pulse-board-
            # truth's --stdout report had been calling out "open action
            # card(s) with no link surface" for days with nothing enforcing
            # it. An action card is a request for Mike to DO something; if
            # nothing on it is clickable he is left translating a sentence
            # into a command himself, which is exactly the failure mode the
            # board standard (README §"Board standard") already names as
            # invalid authoring. Refusing here means a producer with no real
            # affordance for an item (e.g. a prose bullet lifted from a
            # markdown report with no URL behind it) cannot land it as a
            # fake "action" card — that is the producer's signal the item
            # isn't ready for the board yet, not something to paper over.
            raise CardContractError(
                "no_link_surface",
                "action card has no way for Mike to act on it — no --url, "
                "no --step-actions open_url step, and no --actions typed "
                "action",
                hint=(
                    "Give it one of: --url (a deep link to the exact "
                    "place), --actions (a typed payload.actions v1 button), "
                    "or a --step-actions open_url step. If none of those "
                    "exist yet, this item isn't ready to be a card — keep "
                    "it as informational text (e.g. inside a brief's "
                    "--lines/--full-text) until it has a real affordance."
                ),
            )

        # R2b SOFT GATE (2026-08-15, Mike: "the board is a console, not a
        # message board" — handshake-protocol-v1.md §R2b). The hard gate
        # above only demands ONE clickable thing somewhere on the card; a
        # card can pass it with a single `--url` and still carry a numbered
        # `--steps` checklist that is pure prose Mike has to read and
        # translate into clicks by hand — exactly card 7fc788c0's shape
        # before its R2b rebuild (four lines of "1) ... 2) ... 3) ...").
        # This is deliberately a WARNING, not a hard fail: promoting it
        # follows the estate's own gate-rollout pattern (RLS `using(true)`,
        # the link-surface gate itself) of landing loud-but-non-blocking
        # first, measuring the false-positive rate, then promoting. Tune
        # before promoting — do not flip this to a CardContractError without
        # first checking real authoring traffic the way the link-surface
        # gate's rollout did.
        step_lines = [ln for ln in (payload.get("steps") or "").splitlines() if ln.strip()]
        if step_lines and not payload.get("actions"):
            step_actions_list = payload.get("step_actions") or []
            unactioned = sum(
                1 for i in range(len(step_lines))
                if not (i < len(step_actions_list) and isinstance(step_actions_list[i], dict))
            )
            if unactioned:
                warnings.append(
                    f"R2b: {unactioned}/{len(step_lines)} step(s) in --steps have no matching "
                    "--step-actions entry (and the card carries no typed --actions either) — "
                    "prose steps a human must interpret are a contract violation wherever an "
                    "executable action is possible (handshake-protocol-v1.md §R2b). If a real "
                    "affordance exists for that step, wire it via --step-actions/--actions; if "
                    "none exists yet, consider whether this belongs on the board as an action "
                    "card yet."
                )
    elif card_type == "decision":
        opts = payload.get("options") or []
        if not isinstance(opts, (list, tuple)):
            raise CardContractError(
                "options_shape",
                "options must be a list of strings (comma-separated on the CLI)",
            )
        if len(opts) > 4:
            # 2026-08-14 fix: the board used to hard-slice to 4 with nothing
            # telling Mike a real option was dropped (UX finding). It now
            # renders every option — this warning is just a nudge that a long
            # option list makes for a busier card, not a truncation notice.
            warnings.append(
                f"{len(opts)} options — the board renders all of them, but "
                "that's a lot of buttons on one card. Consider narrowing."
            )
        if not is_present(payload.get("why")) and not is_present(payload.get("url")):
            warnings.append(
                "decision card has neither why nor url. Mike has to ask for the "
                "context, which is the slow path this card type exists to avoid."
            )
    return warnings
