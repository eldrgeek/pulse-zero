#!/usr/bin/env python3
"""Named Pulse addressees — seat registry + contract field.

No live Discord, no Herm gateway, no network. Run standalone:

    python3 test/test_pulse_seats.py
"""
import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
import pulse_card_contract as pcc  # noqa: E402
import pulse_seats as seats  # noqa: E402


class SeatRegistry(unittest.TestCase):
    def test_default_addressee_is_mike(self):
        self.assertEqual(seats.DEFAULT_ADDRESSEE, "mike")
        mike = seats.get_seat(None)
        self.assertEqual(mike["name"], "mike")
        self.assertEqual(mike["kind"], "human")
        self.assertEqual(mike["inbox"], "pulse")

    def test_rook_is_the_first_grok_bot_seat(self):
        rook = seats.get_seat("rook")
        self.assertEqual(rook["name"], "rook")
        self.assertEqual(rook["kind"], "grok-bot")
        self.assertEqual(rook["inbox"], "pulse")
        self.assertIsNone((rook.get("discord") or {}).get("user_id"))
        self.assertFalse(seats.discord_mention_ready(rook))

    def test_rook_lookup_is_case_insensitive(self):
        self.assertEqual(seats.get_seat("Rook")["name"], "rook")
        self.assertEqual(seats.get_seat("ROOK")["name"], "rook")

    def test_herm_profiles_are_not_seats(self):
        for name in ("rally", "mae", "greta", "Rally"):
            with self.subTest(name=name):
                with self.assertRaises(seats.SeatError) as ctx:
                    seats.get_seat(name)
                self.assertEqual(ctx.exception.rule, "herm_profile_not_a_seat")

    def test_unknown_seat_is_rejected(self):
        with self.assertRaises(seats.SeatError) as ctx:
            seats.get_seat("skip")
        self.assertEqual(ctx.exception.rule, "unknown_addressee")

    def test_discord_mention_not_ready_without_user_id(self):
        self.assertFalse(seats.discord_mention_ready(seats.get_seat("mike")))
        self.assertFalse(seats.discord_mention_ready(seats.get_seat("rook")))
        self.assertTrue(seats.discord_mention_ready({
            "discord": {"channel_id": "1", "user_id": "123"},
        }))


class StampAddressee(unittest.TestCase):
    def test_omitted_to_leaves_payload_untouched(self):
        payload = {"title": "Open the thing", "url": "https://example.test"}
        seats.stamp_addressee(payload, None)
        self.assertNotIn("addressee", payload)

    def test_blank_to_leaves_payload_untouched(self):
        payload = {"title": "Open the thing", "url": "https://example.test"}
        seats.stamp_addressee(payload, "   ")
        self.assertNotIn("addressee", payload)

    def test_to_rook_stamps_the_field(self):
        payload = {"title": "Open the thing", "url": "https://example.test"}
        seats.stamp_addressee(payload, "Rook")
        self.assertEqual(payload["addressee"], "rook")

    def test_source_is_independent_of_addressee(self):
        # Provenance stays on the row (created_by); addressee is payload-only.
        payload = {"title": "Open the thing", "url": "https://example.test"}
        seats.stamp_addressee(payload, "rook")
        self.assertEqual(payload["addressee"], "rook")
        self.assertNotIn("created_by", payload)
        self.assertNotIn("source", payload)


class ContractAddressee(unittest.TestCase):
    def test_omitted_addressee_still_passes_every_type(self):
        warnings = pcc.validate_payload(
            "action", {"title": "Open the thing", "url": "https://example.test"}
        )
        self.assertEqual(warnings, [])
        self.assertEqual(
            seats.effective_addressee({"title": "Open the thing"}),
            "mike",
        )

    def test_rook_addressee_is_valid_on_every_card_type(self):
        cases = [
            ("action", {"title": "Open the thing", "url": "https://example.test",
                        "addressee": "rook"}),
            ("decision", {"question": "Pick one?", "options": ["A", "B"],
                          "addressee": "rook"}),
            ("verdict", {"artifact_name": "X", "url": "https://example.test",
                         "summary": "Y", "addressee": "rook"}),
            ("brief", {"title": "Hi", "lines": "short digest", "addressee": "rook"}),
        ]
        for card_type, payload in cases:
            with self.subTest(card_type=card_type):
                pcc.validate_payload(card_type, payload)
                self.assertEqual(payload["addressee"], "rook")

        payload = {
            "title": "Open the thing",
            "url": "https://example.test",
            "addressee": "Rook",
        }
        warnings = pcc.validate_payload("action", payload)
        self.assertEqual(warnings, [])
        self.assertEqual(payload["addressee"], "rook")

    def test_explicit_mike_is_accepted(self):
        payload = {
            "question": "Pick one?",
            "options": ["A", "B"],
            "addressee": "mike",
        }
        pcc.validate_payload("decision", payload)
        self.assertEqual(payload["addressee"], "mike")

    def test_unknown_addressee_is_a_contract_error(self):
        with self.assertRaises(pcc.CardContractError) as ctx:
            pcc.validate_payload(
                "brief",
                {"title": "Hi", "lines": "short", "addressee": "not-a-seat"},
            )
        self.assertEqual(ctx.exception.rule, "unknown_addressee")

    def test_herm_profile_is_a_contract_error(self):
        with self.assertRaises(pcc.CardContractError) as ctx:
            pcc.validate_payload(
                "verdict",
                {
                    "artifact_name": "X",
                    "url": "https://example.test",
                    "summary": "Y",
                    "addressee": "mae",
                },
            )
        self.assertEqual(ctx.exception.rule, "herm_profile_not_a_seat")

    def test_non_string_addressee_is_rejected(self):
        with self.assertRaises(pcc.CardContractError) as ctx:
            pcc.validate_payload(
                "action",
                {"title": "Open the thing", "url": "https://example.test",
                 "addressee": ["rook"]},
            )
        self.assertEqual(ctx.exception.rule, "field_type")

    def test_blank_addressee_is_treated_as_missing(self):
        payload = {
            "title": "Open the thing",
            "url": "https://example.test",
            "addressee": "   ",
        }
        pcc.validate_payload("action", payload)
        self.assertNotIn("addressee", payload)
        self.assertEqual(seats.effective_addressee(payload), "mike")


class BoardKnownSeats(unittest.TestCase):
    """The board cannot import this module. Its KNOWN_SEATS list must
    still match SEATS so a typo --to cannot look like Rook.
    """

    def test_board_known_seats_match_registry(self):
        html = (ROOT / "public" / "index.html").read_text()
        match = re.search(
            r"const KNOWN_SEATS = new Set\(\[([^\]]*)\]\)",
            html,
        )
        self.assertIsNotNone(match, "board KNOWN_SEATS was not found")
        js_seats = {
            item.strip().strip("'\"")
            for item in match.group(1).split(",")
            if item.strip()
        }
        self.assertEqual(js_seats, set(seats.SEATS))

        default = re.search(r"const DEFAULT_ADDRESSEE = '([^']+)'", html)
        self.assertIsNotNone(default, "board DEFAULT_ADDRESSEE was not found")
        self.assertEqual(default.group(1), seats.DEFAULT_ADDRESSEE)

    def test_unknown_slug_is_not_a_known_seat(self):
        self.assertNotIn("rok", seats.SEATS)
        self.assertNotIn("skip", seats.SEATS)


class PulsePushToFlag(unittest.TestCase):
    def test_action_help_documents_to(self):
        import subprocess
        result = subprocess.run(
            [sys.executable, str(ROOT / "bin" / "pulse-push"), "action", "--help"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--to", result.stdout)
        self.assertIn("rook", result.stdout.lower())


if __name__ == "__main__":
    unittest.main()
