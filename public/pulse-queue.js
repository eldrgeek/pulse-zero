(function pulseQueueModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PulseQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildPulseQueue() {
  'use strict';

  const QUEUE_LIMIT = 5;
  const GATE_KINDS = Object.freeze(['authentication', 'consent', 'money', 'judgment']);
  const QUEUE_STATES = Object.freeze(['legacy', 'intake', 'eligible', 'queued', 'hold']);
  const CONTINUATION_VERIFIERS = new Set(['owner_acknowledged', 'external_state', 'artifact_state']);
  const DEFAULT_OPERATION_REGISTRY = Object.freeze({
    'workflow/gdoc_bridge_authorize': Object.freeze({
      verificationKinds: Object.freeze(['google_drive_about']),
      targetRefs: Object.freeze(['google.oauth.consent.primary']),
      targetHosts: Object.freeze(['accounts.google.com']),
    }),
    'workflow/github_accept_org_invite': Object.freeze({
      verificationKinds: Object.freeze(['github_org_membership']),
      targetRefs: Object.freeze(['github.org_invitation.accept']),
      targetHosts: Object.freeze(['github.com']),
      exactOrgInvitation: true,
    }),
  });

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function error(code, detail) {
    return Object.freeze({ code, ...(detail ? { detail } : {}) });
  }

  function parseHttpsUrl(value) {
    if (!nonEmptyString(value)) return null;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && parsed.hostname ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function gateErrors(gate) {
    const errors = [];
    if (!isObject(gate) || gate.version !== 1) {
      return [error('gate_contract_version', 'gate_contract.version must be 1')];
    }
    if (!GATE_KINDS.includes(gate.kind)) errors.push(error('gate_kind'));
    if (!nonEmptyString(gate.reason_only_mike)) errors.push(error('gate_reason_missing'));
    if (!Number.isInteger(gate.estimated_human_seconds) || gate.estimated_human_seconds < 1) {
      errors.push(error('gate_estimate_invalid'));
    }
    const target = gate.target;
    if (!isObject(target) || !['pulse', 'web'].includes(target.surface)) {
      errors.push(error('gate_target_surface'));
      return errors;
    }
    if (!nonEmptyString(target.label)) errors.push(error('gate_target_label'));
    if (target.surface === 'web') {
      if (!parseHttpsUrl(target.url)) errors.push(error('gate_target_https'));
      if (!nonEmptyString(target.ref)) errors.push(error('gate_target_ref'));
    }
    if (gate.kind === 'money') {
      const money = gate.money;
      if (!isObject(money) || typeof money.amount !== 'number' || money.amount < 0 ||
          typeof money.maximum_authorized_amount !== 'number' ||
          money.maximum_authorized_amount < money.amount ||
          !/^[A-Z]{3}$/.test((money && money.currency) || '') ||
          !nonEmptyString(money && money.payee)) {
        errors.push(error('money_terms_invalid'));
      }
    }
    return errors;
  }

  function continuationErrors(contract) {
    if (!isObject(contract) || contract.version !== 1) {
      return [error('continuation_contract_version')];
    }
    const errors = [];
    if (!nonEmptyString(contract.owner_ref)) errors.push(error('continuation_owner_missing'));
    if (!['gate_answered', 'actions_verified'].includes(contract.trigger)) {
      errors.push(error('continuation_trigger_invalid'));
    }
    if (contract.operation !== 'resume_card_owner') errors.push(error('continuation_operation_invalid'));
    if (!nonEmptyString(contract.correlation_key)) errors.push(error('continuation_correlation_missing'));
    if (!isObject(contract.verification) || !CONTINUATION_VERIFIERS.has(contract.verification.kind)) {
      errors.push(error('continuation_verifier_invalid'));
    }
    if (!nonEmptyString(contract.success_message)) errors.push(error('continuation_success_missing'));
    return errors;
  }

  function actionErrors(card, registry) {
    const payload = isObject(card.payload) ? card.payload : {};
    if (payload.actions_version !== 1 || !Array.isArray(payload.actions) || payload.actions.length === 0) {
      return [error('typed_action_required')];
    }
    const errors = [];
    const ids = new Set();
    for (const action of payload.actions) {
      if (!isObject(action) || !nonEmptyString(action.id)) {
        errors.push(error('typed_action_invalid'));
        continue;
      }
      if (ids.has(action.id)) errors.push(error('typed_action_duplicate_id', action.id));
      ids.add(action.id);
      const operationKey = `${action.executor || ''}/${action.operation || ''}`;
      const spec = registry[operationKey];
      if (!spec) {
        errors.push(error('unsupported_operation', operationKey));
        continue;
      }
      if (!Number.isInteger(action.revision) || action.revision < 1 || !isObject(action.params)) {
        errors.push(error('typed_action_invalid', action.id));
      }
      if (!isObject(action.completion) || action.completion.mode !== 'verified' ||
          !nonEmptyString(action.completion.success_message)) {
        errors.push(error('unverified_completion', action.id));
      }
      const verificationKind = isObject(action.verification) ? action.verification.kind : null;
      if (!spec.verificationKinds.includes(verificationKind)) {
        errors.push(error('unsupported_verification', String(verificationKind || '')));
      }
      const actionGate = action.human_gate;
      const actionTarget = isObject(actionGate) ? actionGate.target : null;
      const queueTarget = card.gate_contract && card.gate_contract.target;
      if (!isObject(actionGate) || !nonEmptyString(actionGate.instruction) || !isObject(actionTarget)) {
        errors.push(error('action_human_gate_required', action.id));
        continue;
      }
      const parsed = parseHttpsUrl(actionTarget.url);
      if (!parsed || !spec.targetHosts.includes(parsed.hostname) ||
          !spec.targetRefs.includes(actionTarget.ref)) {
        errors.push(error('unsupported_gate_target', action.id));
      }
      if (spec.exactOrgInvitation) {
        const org = action.params && action.params.org;
        const username = action.params && action.params.username;
        const githubName = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
        if (!githubName.test(org || '') || !githubName.test(username || '') ||
            Object.keys(action.params || {}).sort().join(',') !== 'org,username' ||
            !parsed || parsed.pathname.replace(/\/$/, '') !== `/orgs/${org}/invitation`) {
          errors.push(error('github_invitation_contract_invalid', action.id));
        }
      }
      if (queueTarget && (queueTarget.ref !== actionTarget.ref || queueTarget.label !== actionTarget.label)) {
        errors.push(error('gate_target_mismatch', action.id));
      }
    }
    return errors;
  }

  function baseEligibilityErrors(card, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const registry = options.operationRegistry || DEFAULT_OPERATION_REGISTRY;
    const errors = [];
    if (!isObject(card)) return [error('card_invalid')];
    if (card.contract_version !== 1) errors.push(error('contract_version'));
    if (card.status !== 'open') errors.push(error('card_not_open'));
    if (!QUEUE_STATES.includes(card.queue_state) || card.queue_state === 'legacy') {
      errors.push(error('queue_not_opted_in'));
    }
    if (card.snoozed_until && new Date(card.snoozed_until) > now) errors.push(error('card_snoozed'));
    if (card.type === 'brief') errors.push(error('brief_ineligible'));
    if (!nonEmptyString(card.dedupe_key)) errors.push(error('dedupe_key_required'));
    if (!Number.isInteger(card.priority_band) || card.priority_band < 0 || card.priority_band > 3) {
      errors.push(error('priority_band_invalid'));
    }
    if (!nonEmptyString(card.priority_reason)) errors.push(error('priority_reason_required'));
    if (!Number.isInteger(card.blocked_work_count) || card.blocked_work_count < 0) {
      errors.push(error('blocked_work_count_invalid'));
    }
    errors.push(...gateErrors(card.gate_contract));
    errors.push(...continuationErrors(card.continuation_contract));

    if (card.type === 'action') {
      if (!['authentication', 'consent'].includes((card.gate_contract || {}).kind) ||
          !card.gate_contract.target || card.gate_contract.target.surface !== 'web' ||
          (card.continuation_contract || {}).trigger !== 'actions_verified') {
        errors.push(error('action_gate_contract_mismatch'));
      }
      errors.push(...actionErrors(card, registry));
    } else if (['decision', 'verdict'].includes(card.type)) {
      const gate = card.gate_contract || {};
      if (gate.kind !== 'judgment' || !gate.target || gate.target.surface !== 'pulse' ||
          (card.continuation_contract || {}).trigger !== 'gate_answered') {
        errors.push(error('pulse_judgment_gate_required'));
      }
      if (card.type === 'decision') {
        const optionsList = card.payload && card.payload.options;
        if (!Array.isArray(optionsList) || optionsList.length < 2) errors.push(error('decision_options_incomplete'));
      }
    } else if (card.type !== 'brief') {
      errors.push(error('card_type_ineligible'));
    }
    return errors;
  }

  function missionRank(lane) {
    const normalized = String(lane || '').trim().toLowerCase();
    if (normalized === 'legends') return 0;
    if (normalized === 'playmaker' || normalized === 'playwriting') return 1;
    if (normalized === 'soma' || normalized.startsWith('soma-')) return 2;
    return 3;
  }

  function compareCards(left, right) {
    const numeric = (Number(left.priority_band) - Number(right.priority_band)) ||
      ((left.deadline_at ? new Date(left.deadline_at).getTime() : Number.POSITIVE_INFINITY) -
       (right.deadline_at ? new Date(right.deadline_at).getTime() : Number.POSITIVE_INFINITY)) ||
      (missionRank(left.mission_lane) - missionRank(right.mission_lane)) ||
      (Number(right.blocked_work_count || 0) - Number(left.blocked_work_count || 0)) ||
      (new Date(left.eligible_at || 0).getTime() - new Date(right.eligible_at || 0).getTime());
    return numeric || String(left.id || '').localeCompare(String(right.id || ''));
  }

  function rankQueue(cards, options = {}) {
    const limit = Math.min(QUEUE_LIMIT, Math.max(0, Number(options.limit ?? QUEUE_LIMIT)));
    const holds = [];
    const valid = [];
    const byKey = new Map();
    for (const card of cards || []) {
      const errors = baseEligibilityErrors(card, options);
      if (errors.length) {
        holds.push({ card, errors });
        continue;
      }
      const prior = byKey.get(card.dedupe_key);
      if (!prior) {
        byKey.set(card.dedupe_key, card);
        valid.push(card);
        continue;
      }
      const duplicateOrder =
        (new Date(prior.eligible_at || prior.created_at || 0).getTime() -
         new Date(card.eligible_at || card.created_at || 0).getTime()) ||
        String(prior.id || '').localeCompare(String(card.id || ''));
      const winner = duplicateOrder <= 0 ? prior : card;
      const duplicate = winner === prior ? card : prior;
      if (winner !== prior) {
        const priorIndex = valid.indexOf(prior);
        valid.splice(priorIndex, 1, card);
        byKey.set(card.dedupe_key, card);
      }
      holds.push({ card: duplicate, errors: [error('duplicate_gate', winner.id)] });
    }
    valid.sort(compareCards);
    const queue = valid.slice(0, limit).map((card, index) => ({ ...card, queue_position: index + 1 }));
    return Object.freeze({ queue, overflow: valid.slice(limit), holds });
  }

  function executionState(run, continuation) {
    if (!run && !continuation) return 'ready';
    if (!run && continuation) {
      if (['queued', 'running'].includes(continuation.status)) return 'team_resuming';
      if (continuation.status === 'verifying') return 'verifying';
      if (continuation.status === 'succeeded') return 'cleared';
      return 'could_not_verify';
    }
    const result = isObject(run.result) ? run.result : {};
    if (run.status === 'failed' || (run.status === 'done' && result.verified !== true)) {
      return 'could_not_verify';
    }
    if (run.status !== 'done') {
      if (result.state === 'waiting_human' && result.human_gate && result.human_gate.target_ready === true) {
        return 'your_turn';
      }
      return 'team_preparing';
    }
    if (!continuation || ['queued', 'running'].includes(continuation.status)) return 'team_resuming';
    if (continuation.status === 'verifying') return 'verifying';
    if (continuation.status === 'succeeded') return 'cleared';
    return 'could_not_verify';
  }

  return Object.freeze({
    QUEUE_LIMIT,
    GATE_KINDS,
    QUEUE_STATES,
    DEFAULT_OPERATION_REGISTRY,
    gateErrors,
    continuationErrors,
    baseEligibilityErrors,
    compareCards,
    rankQueue,
    executionState,
  });
});
