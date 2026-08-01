#!/usr/bin/env python3
import pathlib
import runpy
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PULSE_PUSH = runpy.run_path(str(ROOT / "bin" / "pulse-push"))
validate_card_actions = PULSE_PUSH["validate_card_actions"]
validate_action_revision_change = PULSE_PUSH["validate_action_revision_change"]
validate_queue_contract = PULSE_PUSH["validate_queue_contract"]


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


def valid_queue_action():
    return valid_action(
        executor="workflow",
        operation="gdoc_bridge_authorize",
        params={"project_id": "fixture-project", "account": "fixture@example.invalid"},
        human_gate={
            "instruction": "Click Continue on the deterministic test surface.",
            "target": {
                "url": "https://accounts.google.com/o/oauth2/v2/auth",
                "ref": "google.oauth.consent.primary",
                "label": "Continue",
            },
        },
        verification={"kind": "google_drive_about", "params": {}},
    )


def valid_gate():
    return {
        "version": 1,
        "kind": "consent",
        "reason_only_mike": "Only Mike can grant the fixture consent.",
        "estimated_human_seconds": 20,
        "target": {
            "surface": "web",
            "url": "https://accounts.google.com/o/oauth2/v2/auth",
            "ref": "google.oauth.consent.primary",
            "label": "Continue",
        },
    }


def valid_continuation():
    return {
        "version": 1,
        "owner_ref": "fixture:owner",
        "trigger": "actions_verified",
        "operation": "resume_card_owner",
        "correlation_key": "fixture-queue-card",
        "verification": {"kind": "owner_acknowledged", "params": {}},
        "success_message": "Fixture owner resumed.",
    }


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

    def test_queue_authoring_accepts_reviewed_typed_gate(self):
        payload = {"actions_version": 1, "actions": [valid_queue_action()]}
        validate_queue_contract(
            "action", payload, valid_gate(), valid_continuation(),
            "fixture-gate", 1, "Blocks a deterministic fixture.", 1,
        )

    def test_queue_authoring_rejects_legacy_yeshie_and_unsupported_operation(self):
        payload = {"actions_version": 1, "actions": [valid_queue_action()]}
        with self.assertRaisesRegex(ValueError, "legacy --yeshie-task"):
            validate_queue_contract(
                "action", payload, valid_gate(), valid_continuation(),
                "fixture-gate", 1, "Blocks a deterministic fixture.", 1,
                yeshie_task={"recipe_path": "legacy.json"},
            )
        payload["actions"][0]["operation"] = "run_yeshie_recipe"
        with self.assertRaisesRegex(ValueError, "not reviewed"):
            validate_queue_contract(
                "action", payload, valid_gate(), valid_continuation(),
                "fixture-gate", 1, "Blocks a deterministic fixture.", 1,
            )

    def test_queue_authoring_accepts_genuine_pulse_judgment(self):
        gate = valid_gate()
        gate.update({"kind": "judgment", "target": {"surface": "pulse", "label": "Choose an option"}})
        continuation = valid_continuation()
        continuation["trigger"] = "gate_answered"
        validate_queue_contract(
            "decision", {"options": ["A", "B", "Other"]}, gate, continuation,
            "fixture-decision", 2, "Unblocks the fixture owner.", 1,
        )

    def test_queue_authoring_accepts_reviewed_github_invitation_contract(self):
        action = valid_queue_action()
        action.update({
            "id": "github-invite",
            "operation": "github_accept_org_invite",
            "params": {"org": "FixtureOrg", "username": "fixture-user"},
            "verification": {"kind": "github_org_membership", "params": {}},
            "human_gate": {
                "instruction": "Click the highlighted invitation control.",
                "target": {
                    "url": "https://github.com/orgs/FixtureOrg/invitation",
                    "ref": "github.org_invitation.accept",
                    "label": "Accept invitation",
                },
            },
        })
        gate = valid_gate()
        gate["target"] = {
            "surface": "web",
            **action["human_gate"]["target"],
        }
        validate_queue_contract(
            "action", {"actions_version": 1, "actions": [action]}, gate,
            valid_continuation(), "fixture-github-invite", 1,
            "Blocks the deterministic fixture workflow.", 2,
        )


if __name__ == "__main__":
    unittest.main()
