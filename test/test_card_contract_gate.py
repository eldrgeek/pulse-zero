#!/usr/bin/env python3
"""Regression test for the 2026-08-13 hard link-surface gate and the brief
card's optional full_text field (pulse_card_contract.py). Run standalone:

    python3 test/test_card_contract_gate.py

Mike's ask: "refuse to emit a link-less action card" — every producer that
goes through validate_payload() (pulse-push, pulse_common.push_card via
pulse-morning/pulse-drain, pulse-enqueue at enqueue time) must inherit this.
"""
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
import pulse_card_contract as pcc  # noqa: E402


class ActionLinkSurfaceGate(unittest.TestCase):
    def test_no_url_no_actions_no_step_link_is_rejected(self):
        with self.assertRaises(pcc.CardContractError) as ctx:
            pcc.validate_payload("action", {"title": "Do the thing", "why": "context"})
        self.assertEqual(ctx.exception.rule, "no_link_surface")

    def test_url_is_accepted(self):
        warnings = pcc.validate_payload(
            "action", {"title": "Open the thing", "url": "https://example.test"}
        )
        self.assertEqual(warnings, [])

    def test_typed_actions_are_accepted_without_url(self):
        warnings = pcc.validate_payload(
            "action",
            {"title": "Approve X", "actions": [{"id": "a", "label": "Approve"}]},
        )
        self.assertEqual(warnings, [])

    def test_step_actions_open_url_is_accepted_without_url(self):
        warnings = pcc.validate_payload(
            "action",
            {
                "title": "Open the thing",
                "step_actions": [{"command": "open_url", "url": "https://example.test"}],
            },
        )
        self.assertEqual(warnings, [])

    def test_blank_url_still_counts_as_missing(self):
        with self.assertRaises(pcc.CardContractError):
            pcc.validate_payload("action", {"title": "Do the thing", "url": "   "})


class UrlSchemeGate(unittest.TestCase):
    """CODE#4 (2026-08-14, fix wave): javascript:/data:/other-scheme URLs must
    be refused at the contract layer, not just at render time."""

    def test_javascript_scheme_is_rejected(self):
        with self.assertRaises(pcc.CardContractError) as ctx:
            pcc.validate_payload(
                "action",
                {"title": "Open the thing", "url": "javascript:alert(1)"},
            )
        self.assertEqual(ctx.exception.rule, "unsafe_url_scheme")

    def test_data_scheme_is_rejected(self):
        with self.assertRaises(pcc.CardContractError) as ctx:
            pcc.validate_payload(
                "verdict",
                {"artifact_name": "X", "summary": "Y",
                 "url": "data:text/html,<script>alert(1)</script>"},
            )
        self.assertEqual(ctx.exception.rule, "unsafe_url_scheme")

    def test_https_scheme_is_accepted(self):
        warnings = pcc.validate_payload(
            "decision",
            {"question": "Pick one?", "options": ["A", "B"], "url": "https://example.test"},
        )
        self.assertEqual(warnings, [])

    def test_http_scheme_is_accepted(self):
        warnings = pcc.validate_payload(
            "action", {"title": "Open the thing", "url": "http://example.test"}
        )
        self.assertEqual(warnings, [])

    def test_missing_url_is_not_a_scheme_violation(self):
        # Absence is validate_required_fields'/the link-surface gate's job;
        # this gate must not fire on a card that has no url at all.
        with self.assertRaises(pcc.CardContractError) as ctx:
            pcc.validate_payload("action", {"title": "Approve X", "actions": []})
        self.assertNotEqual(ctx.exception.rule, "unsafe_url_scheme")


class R2bProseStepsWarning(unittest.TestCase):
    """2026-08-15 soft gate (handshake-protocol-v1.md §R2b): a --steps line
    with no matching --step-actions entry and no typed --actions warns
    (never rejects — this is the estate's loud-first, promote-later
    rollout pattern, same as the link-surface gate's own history)."""

    def test_prose_steps_with_no_actions_warns(self):
        warnings = pcc.validate_payload(
            "action",
            {
                "title": "Do the three things",
                "url": "https://example.test",  # satisfies the hard link-surface gate
                "steps": "1) do a\n2) do b\n3) do c",
            },
        )
        self.assertTrue(any(w.startswith("R2b:") for w in warnings))
        self.assertTrue(any("3/3" in w for w in warnings))

    def test_steps_fully_covered_by_step_actions_does_not_warn(self):
        warnings = pcc.validate_payload(
            "action",
            {
                "title": "Do the three things",
                "steps": "1) do a\n2) do b\n3) do c",
                "step_actions": [
                    {"command": "open_url", "payload": {"url": "https://example.test/a"}},
                    {"command": "open_url", "payload": {"url": "https://example.test/b"}},
                    {"command": "open_url", "payload": {"url": "https://example.test/c"}},
                ],
            },
        )
        self.assertFalse(any(w.startswith("R2b:") for w in warnings))

    def test_typed_actions_present_suppresses_the_warning_even_with_prose_steps(self):
        warnings = pcc.validate_payload(
            "action",
            {
                "title": "Approve X",
                "actions": [{"id": "a", "label": "Approve"}],
                "steps": "1) read the diff\n2) approve it",
            },
        )
        self.assertFalse(any(w.startswith("R2b:") for w in warnings))

    def test_no_steps_at_all_does_not_warn(self):
        warnings = pcc.validate_payload(
            "action", {"title": "Open the thing", "url": "https://example.test"}
        )
        self.assertFalse(any(w.startswith("R2b:") for w in warnings))


class DecisionOptionsUncapped(unittest.TestCase):
    """UX finding (2026-08-14): the board used to hard-slice decision options
    to 4 with no on-card signal. It now renders all of them; the contract
    should warn (not reject) on a long list, and never claim they're dropped."""

    def test_more_than_four_options_warns_but_does_not_reject(self):
        warnings = pcc.validate_payload(
            "decision",
            {"question": "Pick one?", "options": ["A", "B", "C", "D", "E", "F"]},
        )
        self.assertTrue(any("options" in w for w in warnings))
        self.assertFalse(any("invisible" in w for w in warnings))


class BriefFullText(unittest.TestCase):
    def test_full_text_is_optional_and_additive(self):
        warnings = pcc.validate_payload(
            "brief", {"title": "Hi", "lines": "short digest"}
        )
        self.assertEqual(warnings, [])

    def test_full_text_present_still_passes(self):
        warnings = pcc.validate_payload(
            "brief",
            {"title": "Hi", "lines": "short digest", "full_text": "the long body\nline 2"},
        )
        self.assertEqual(warnings, [])

    def test_lines_still_required(self):
        with self.assertRaises(pcc.CardContractError):
            pcc.validate_payload("brief", {"title": "Hi", "full_text": "only the long body"})


if __name__ == "__main__":
    unittest.main()
