(function pulseActionsModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PulseActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildPulseActions() {
  'use strict';

  const CONTRACT_VERSION = 1;
  const EXECUTORS = new Set(['workflow', 'web', 'mac']);
  const ACTION_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
  const TARGET_REF_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
  const ACTIVE_STATUSES = new Set(['open', 'running', 'waiting_human']);

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function isAbsoluteHttpsUrl(value) {
    if (!nonEmptyString(value)) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && !!parsed.hostname;
    } catch (_) {
      return false;
    }
  }

  function actionErrors(action, index) {
    const at = `actions[${index}]`;
    const errors = [];
    if (!isObject(action)) return [`${at} must be an object`];
    if (!ACTION_ID_RE.test(action.id || '')) {
      errors.push(`${at}.id must be a lowercase slug (letters, numbers, hyphens)`);
    }
    if (!Number.isInteger(action.revision) || action.revision < 1) {
      errors.push(`${at}.revision must be a positive integer`);
    }
    if (!EXECUTORS.has(action.executor)) {
      errors.push(`${at}.executor must be workflow, web, or mac`);
    }
    if (!nonEmptyString(action.label)) errors.push(`${at}.label is required`);
    if ('description' in action && !nonEmptyString(action.description)) {
      errors.push(`${at}.description must be a non-empty string when present`);
    }
    if (!nonEmptyString(action.operation)) errors.push(`${at}.operation is required`);
    if (!isObject(action.params)) errors.push(`${at}.params must be an object`);

    const completion = action.completion;
    if (!isObject(completion) || completion.mode !== 'verified') {
      errors.push(`${at}.completion.mode must be verified`);
    }
    if (!isObject(completion) || !nonEmptyString(completion.success_message)) {
      errors.push(`${at}.completion.success_message is required`);
    }
    if (isObject(completion) && 'close_card' in completion && typeof completion.close_card !== 'boolean') {
      errors.push(`${at}.completion.close_card must be a boolean when present`);
    }

    const verification = action.verification;
    if (!isObject(verification) || !nonEmptyString(verification.kind)) {
      errors.push(`${at}.verification.kind is required`);
    }
    if (isObject(verification) && 'params' in verification && !isObject(verification.params)) {
      errors.push(`${at}.verification.params must be an object when present`);
    }

    if ('human_gate' in action) {
      if (!['workflow', 'web'].includes(action.executor)) {
        errors.push(`${at}.human_gate is only valid for workflow or web executors`);
      }
      const gate = action.human_gate;
      if (!isObject(gate) || !nonEmptyString(gate.instruction)) {
        errors.push(`${at}.human_gate.instruction is required`);
      }
      const target = isObject(gate) ? gate.target : null;
      if (!isObject(target)) {
        errors.push(`${at}.human_gate.target must be an object`);
      } else {
        if (!isAbsoluteHttpsUrl(target.url)) {
          errors.push(`${at}.human_gate.target.url must be an absolute https URL`);
        }
        if (!TARGET_REF_RE.test(target.ref || '')) {
          errors.push(`${at}.human_gate.target.ref must name a Yeshie abstract target`);
        }
        if (!nonEmptyString(target.label)) {
          errors.push(`${at}.human_gate.target.label is required`);
        }
      }
    }
    return errors;
  }

  function parsePayload(payload) {
    const errors = [];
    if (!isObject(payload)) return { actions: [], errors: ['payload must be an object'] };
    if (!('actions' in payload)) return { actions: [], errors: [] };
    if (payload.actions_version !== CONTRACT_VERSION) {
      errors.push(`actions_version must be ${CONTRACT_VERSION}`);
    }
    if (!Array.isArray(payload.actions)) {
      errors.push('actions must be an array');
      return { actions: [], errors };
    }
    const seen = new Set();
    payload.actions.forEach((action, index) => {
      errors.push(...actionErrors(action, index));
      if (isObject(action) && ACTION_ID_RE.test(action.id || '')) {
        if (seen.has(action.id)) errors.push(`actions[${index}].id duplicates ${action.id}`);
        seen.add(action.id);
      }
    });
    return { actions: errors.length ? [] : payload.actions.slice(), errors };
  }

  function actionRunKey(cardId, action) {
    return `${cardId}:${action.id}:r${action.revision}`;
  }

  function idempotencyKey(cardId, action, attempt) {
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
    return `pulse-zero:${cardId}:${action.id}:r${action.revision}:a${attempt}`;
  }

  function buildCommandRow(card, action, attempt) {
    const errors = actionErrors(action, 0);
    if (errors.length) throw new Error(errors.join('; '));
    if (!isObject(card) || !nonEmptyString(card.id)) throw new Error('card.id is required');
    const key = idempotencyKey(card.id, action, attempt);
    return {
      command: 'execute_card_action',
      payload: {
        contract_version: CONTRACT_VERSION,
        card_id: card.id,
        action_id: action.id,
        revision: action.revision,
        idempotency_key: key,
        action,
      },
      status: 'open',
      pulse_card_id: card.id,
      pulse_action_id: action.id,
      pulse_revision: action.revision,
      attempt,
      idempotency_key: key,
    };
  }

  // Queue v1 never lets the browser supply an action envelope. The database
  // re-reads the reviewed action from the queued card and constructs the
  // mac_commands row. buildCommandRow remains for legacy typed cards during
  // the compatibility window.
  function enqueueRpcArgs(card, action, attempt) {
    const errors = actionErrors(action, 0);
    if (errors.length) throw new Error(errors.join('; '));
    if (!isObject(card) || !nonEmptyString(card.id)) throw new Error('card.id is required');
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
    return {
      p_card_id: card.id,
      p_action_id: action.id,
      p_revision: action.revision,
      p_attempt: attempt,
    };
  }

  function latestRun(runs, cardId, action) {
    return (runs || [])
      .filter((run) =>
        String(run.pulse_card_id) === String(cardId) &&
        run.pulse_action_id === action.id &&
        Number(run.pulse_revision) === action.revision
      )
      .sort((a, b) => {
        const byAttempt = Number(b.attempt || 0) - Number(a.attempt || 0);
        if (byAttempt) return byAttempt;
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      })[0] || null;
  }

  function runPhase(run) {
    if (!run) return 'idle';
    if (run.status === 'done') return run.result && run.result.verified === true ? 'verified' : 'failed';
    if (run.status === 'failed') return 'failed';
    if (ACTIVE_STATUSES.has(run.status)) {
      const reported = run.result && run.result.state;
      if (['queued', 'running', 'waiting_human'].includes(reported)) return reported;
      return run.status === 'open' ? 'queued' : run.status;
    }
    return 'failed';
  }

  function safeResultMessage(run, action) {
    const result = isObject(run && run.result) ? run.result : {};
    if (nonEmptyString(result.safe_message)) return result.safe_message.trim();
    const phase = runPhase(run);
    if (phase === 'waiting_human' && action && action.human_gate) {
      return action.human_gate.instruction;
    }
    if (phase === 'verified') return action.completion.success_message;
    if (phase === 'failed') {
      return 'This action did not complete safely. Use Ask Pulse to diagnose before retrying.';
    }
    if (phase === 'running') return 'The executor is working and will report a verified result here.';
    if (phase === 'queued') return 'Queued for the executor. Reloading this page will not enqueue it again.';
    return '';
  }

  function nextAttempt(run) {
    return run ? Number(run.attempt || 0) + 1 : 1;
  }

  return Object.freeze({
    CONTRACT_VERSION,
    EXECUTORS,
    actionErrors,
    parsePayload,
    actionRunKey,
    idempotencyKey,
    buildCommandRow,
    enqueueRpcArgs,
    latestRun,
    runPhase,
    safeResultMessage,
    nextAttempt,
  });
});
