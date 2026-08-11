'use strict';
/**
 * soma-invariant-deterministic.js — WQ-251.
 *
 * A dependency-free JS port of the DETERMINISTIC subset of
 * SOMA/tools/soma_invariant_gate.py: the SCHEMA_CONTRACT rule and the
 * WI1_IDENTITY_DEDUPE rule.
 *
 * WHY THIS EXISTS
 *   netlify/functions/soma-invariant-shadow.js evaluates by `spawnSync`-ing the
 *   Python gate. Netlify's function runtime has no Python and no way to ship one,
 *   so in production that spawn always fails and the adapter can only ever return
 *   {status:'degraded'} — which is why SOMA_INVARIANT_SHADOW has to stay unset in
 *   prod. The shadow has therefore never observed a single real production
 *   feedback ingress. This module removes the spawn from the deterministic path.
 *
 * SCOPE — read this before extending it
 *   Ported: SCHEMA_CONTRACT, WI1_IDENTITY_DEDUPE. These are pure functions of the
 *   input document; no clock, no filesystem, no network.
 *   NOT ported: OS1_OWNER_LEASE_RETURN, TC2, TC3, TC4, TC5. Those are the
 *   turn_close rules; feedback ingress (the only mode this function sees) does not
 *   evaluate TC*, and OS1 is deliberately left out of scope by WQ-251. If you add
 *   one, add its fixtures to the conformance corpus in the same commit — the whole
 *   point of this module is that two implementations cannot drift silently.
 *
 * DRIFT CONTROL
 *   SOMA/invariants/fixtures/ is the shared conformance corpus. Both
 *   implementations run against it in
 *   pulse-zero/test/invariant-js-conformance.test.js, which fails if the JS and
 *   Python error lists differ by even one string. Error strings are therefore part
 *   of the contract: match Python's wording exactly, including punctuation.
 *
 * Author: Dee (Opus 5) for Mike Wolf, 2026-08-11. Filed as WQ-251 by CCc/Fable 2026-08-01.
 */

const POLICY_VERSION = 'soma-invariants/1';
const INPUT_CONTRACT = 'soma-invariant-check-input/1';

const WORK_ITEM_RE = /^wi_[a-z0-9][a-z0-9_-]{7,127}$/;
const RECEIPT_RE = /^rcpt_[a-z0-9][a-z0-9_-]{7,127}$/;
const FINGERPRINT_RE = /^sha256:[a-f0-9]{64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const WORK_ITEM_KINDS = new Set(['feedback', 'task', 'human_gate']);
const WORK_ITEM_STATES = new Set([
  'submitted', 'clarifying', 'accepted', 'assigned', 'in_progress',
  'verification_pending', 'verified', 'closed', 'declined', 'superseded',
]);
const CLASSIFICATIONS = new Set(['DONE', 'OWNED', 'GATED', 'KILLED']);
const OWNED_STATES = new Set(['accepted', 'assigned', 'in_progress', 'verification_pending']);
const TERMINAL_STATES = new Set(['verified', 'closed', 'declined', 'superseded']);
const RECEIPT_TYPES = new Set([
  'submission', 'clarification', 'dedupe', 'assignment', 'execution',
  'verification', 'human_gate', 'closure', 'blocker',
]);
const RECEIPT_STATUSES = new Set(['pass', 'fail', 'pending', 'abstain']);
const ENVIRONMENTS = new Set(['local', 'test', 'preview', 'staging', 'production', 'not_applicable']);
const RETURN_KINDS = new Set(['dispatch_return', 'pulse_resume', 'thread_resume', 'review_queue', 'webhook']);
const ACTOR_ROLES = new Set(['reporter', 'router', 'worker', 'verifier', 'human', 'system']);
const GATE_REASONS = new Set(['authentication', 'consent', 'money', 'judgment']);
const EVIDENCE_KINDS = new Set([
  'database_row', 'artifact', 'command_output', 'test_run',
  'deployment_probe', 'human_action', 'content_hash',
]);

const TOP_LEVEL_KEYS = new Set([
  'contract', 'mode', 'turn_id', 'surface', 'observed_at',
  'work_items', 'receipts', 'delegated_work', 'pulse_cards', 'claims',
]);
const WORK_ITEM_KEYS = new Set([
  'work_item_id', 'kind', 'source_ref', 'fingerprint', 'state', 'classification',
  'owner', 'related_ids', 'receipt_ids', 'kill_reason', 'policy_version',
]);
const RECEIPT_KEYS = new Set([
  'receipt_id', 'work_item_id', 'type', 'issued_at', 'fresh_until', 'actor',
  'scope', 'status', 'evidence', 'details', 'policy_version',
]);

// --- helpers -------------------------------------------------------------
// isDict must mirror Python's isinstance(value, dict): arrays and null are NOT dicts.
const isDict = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const has = (obj, key) => isDict(obj) && Object.prototype.hasOwnProperty.call(obj, key);

/** Python's str(x) for the values that reach these regex checks. */
function pystr(v) {
  if (v === undefined || v === null) return v === null ? 'None' : 'None';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (Array.isArray(v) || isDict(v)) return JSON.stringify(v);
  return String(v);
}

/**
 * RFC3339 with an explicit offset, matching what the Python gate accepts after
 * `value.replace("Z", "+00:00")` + `datetime.fromisoformat` + the tzinfo check.
 * Returns a Date (UTC) or null. A naive timestamp is rejected as "must include a
 * timezone", which is a DIFFERENT message from a malformed one — keep them apart.
 */
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/;

function parseTime(value, path, errors) {
  if (!nonempty(value)) {
    errors.push(`${path} must be an RFC3339 date-time`);
    return null;
  }
  const m = RFC3339_RE.exec(value);
  if (!m) {
    errors.push(`${path} must be an RFC3339 date-time`);
    return null;
  }
  if (!m[8]) {
    errors.push(`${path} must include a timezone`);
    return null;
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ''}` +
    (m[8].toUpperCase() === 'Z' ? 'Z' : m[8]);
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    errors.push(`${path} must be an RFC3339 date-time`);
    return null;
  }
  return new Date(t);
}

/** Python: for key in sorted(set(value) - allowed). Sorting is codepoint order. */
function unknownKeys(value, allowed, path, errors) {
  const extra = Object.keys(value).filter((k) => !allowed.has(k)).sort();
  for (const key of extra) errors.push(`${path}.${key} is not part of the v1 contract`);
}

function missingRequired(obj, required, path, errors) {
  const absent = required.filter((k) => !has(obj, k)).sort();
  for (const key of absent) errors.push(`${path}.${key} is required`);
}

function validateReturnRoute(value, path, errors) {
  if (!isDict(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  unknownKeys(value, new Set(['kind', 'target', 'correlation_id']), path, errors);
  if (!RETURN_KINDS.has(value.kind)) errors.push(`${path}.kind must be a supported automatic return route`);
  if (!nonempty(value.target)) errors.push(`${path}.target is required`);
  if (!nonempty(value.correlation_id)) errors.push(`${path}.correlation_id is required`);
}

function validateOwner(value, path, errors, observedAt) {
  if (!isDict(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  unknownKeys(value, new Set(['actor', 'lease_until', 'next_check_at', 'return_route']), path, errors);
  if (!nonempty(value.actor)) errors.push(`${path}.actor is required`);
  const lease = parseTime(value.lease_until, `${path}.lease_until`, errors);
  const nextCheck = parseTime(value.next_check_at, `${path}.next_check_at`, errors);
  if (observedAt && lease && lease <= observedAt) errors.push(`${path}.lease_until is expired at observed_at`);
  if (lease && nextCheck && nextCheck > lease) errors.push(`${path}.next_check_at must not be after lease_until`);
  validateReturnRoute(value.return_route, `${path}.return_route`, errors);
}

function validateWorkItem(item, index, observedAt) {
  const path = `work_items[${index}]`;
  const errors = [];
  if (!isDict(item)) return [`${path} must be an object`];
  unknownKeys(item, WORK_ITEM_KEYS, path, errors);
  missingRequired(item, [
    'work_item_id', 'kind', 'source_ref', 'fingerprint', 'state',
    'related_ids', 'receipt_ids', 'policy_version',
  ], path, errors);
  if (!WORK_ITEM_RE.test(pystr(has(item, 'work_item_id') ? item.work_item_id : ''))) {
    errors.push(`${path}.work_item_id must be a stable wi_ identifier`);
  }
  if (!WORK_ITEM_KINDS.has(item.kind)) errors.push(`${path}.kind is invalid`);
  if (!nonempty(item.source_ref)) errors.push(`${path}.source_ref is required`);
  if (!FINGERPRINT_RE.test(pystr(has(item, 'fingerprint') ? item.fingerprint : ''))) {
    errors.push(`${path}.fingerprint must be sha256:<64 lowercase hex>`);
  }
  if (!WORK_ITEM_STATES.has(item.state)) errors.push(`${path}.state is invalid`);
  if (has(item, 'classification') && !CLASSIFICATIONS.has(item.classification)) {
    errors.push(`${path}.classification is invalid`);
  }
  for (const [key, pattern] of [['related_ids', WORK_ITEM_RE], ['receipt_ids', RECEIPT_RE]]) {
    const value = item[key];
    if (!Array.isArray(value)) {
      errors.push(`${path}.${key} must be an array`);
      continue;
    }
    if (new Set(value.map(pystr)).size !== value.length) errors.push(`${path}.${key} must contain unique values`);
    for (const member of value) {
      if (!pattern.test(pystr(member))) errors.push(`${path}.${key} contains an invalid identifier`);
    }
  }
  if (item.policy_version !== POLICY_VERSION) errors.push(`${path}.policy_version must be ${POLICY_VERSION}`);
  if (has(item, 'owner')) validateOwner(item.owner, `${path}.owner`, errors, observedAt);
  if (OWNED_STATES.has(item.state) && !has(item, 'owner')) {
    errors.push(`${path}.owner is required in state ${pystr(item.state)}`);
  }
  if (item.classification === 'OWNED' && !has(item, 'owner')) {
    errors.push(`${path}.owner is required for classification OWNED`);
  }
  if (item.classification === 'KILLED' && !nonempty(item.kill_reason)) {
    errors.push(`${path}.kill_reason is required for classification KILLED`);
  }
  return errors;
}

function validateReceipt(receipt, index) {
  const path = `receipts[${index}]`;
  const errors = [];
  if (!isDict(receipt)) return [`${path} must be an object`];
  unknownKeys(receipt, RECEIPT_KEYS, path, errors);
  missingRequired(receipt, [
    'receipt_id', 'work_item_id', 'type', 'issued_at', 'actor',
    'scope', 'status', 'evidence', 'details', 'policy_version',
  ], path, errors);
  if (!RECEIPT_RE.test(pystr(has(receipt, 'receipt_id') ? receipt.receipt_id : ''))) {
    errors.push(`${path}.receipt_id must be a stable rcpt_ identifier`);
  }
  if (!WORK_ITEM_RE.test(pystr(has(receipt, 'work_item_id') ? receipt.work_item_id : ''))) {
    errors.push(`${path}.work_item_id must be a stable wi_ identifier`);
  }
  const receiptType = receipt.type;
  if (!RECEIPT_TYPES.has(receiptType)) errors.push(`${path}.type is invalid`);
  parseTime(receipt.issued_at, `${path}.issued_at`, errors);
  if (has(receipt, 'fresh_until')) parseTime(receipt.fresh_until, `${path}.fresh_until`, errors);

  const actor = receipt.actor;
  if (!isDict(actor)) {
    errors.push(`${path}.actor must be an object`);
  } else {
    unknownKeys(actor, new Set(['id', 'role']), `${path}.actor`, errors);
    if (!nonempty(actor.id)) errors.push(`${path}.actor.id is required`);
    if (!ACTOR_ROLES.has(actor.role)) errors.push(`${path}.actor.role is invalid`);
  }

  const scope = receipt.scope;
  if (!isDict(scope)) {
    errors.push(`${path}.scope must be an object`);
  } else {
    unknownKeys(scope, new Set(['subject', 'environment', 'assertions']), `${path}.scope`, errors);
    if (!nonempty(scope.subject)) errors.push(`${path}.scope.subject is required`);
    if (!ENVIRONMENTS.has(scope.environment)) errors.push(`${path}.scope.environment is invalid`);
    const assertions = scope.assertions;
    if (!Array.isArray(assertions) || assertions.length === 0 || !assertions.every(nonempty)) {
      errors.push(`${path}.scope.assertions must be a non-empty string array`);
    } else if (new Set(assertions).size !== assertions.length) {
      errors.push(`${path}.scope.assertions must contain unique values`);
    }
  }

  if (!RECEIPT_STATUSES.has(receipt.status)) errors.push(`${path}.status is invalid`);

  const evidence = receipt.evidence;
  if (!isDict(evidence)) {
    errors.push(`${path}.evidence must be an object`);
  } else {
    unknownKeys(evidence, new Set(['kind', 'ref', 'sha256', 'observed_at']), `${path}.evidence`, errors);
    if (!EVIDENCE_KINDS.has(evidence.kind)) errors.push(`${path}.evidence.kind is invalid`);
    if (!nonempty(evidence.ref)) errors.push(`${path}.evidence.ref is required`);
    if (has(evidence, 'sha256') && !SHA256_RE.test(pystr(evidence.sha256))) {
      errors.push(`${path}.evidence.sha256 must be 64 lowercase hex`);
    }
    if (has(evidence, 'observed_at')) parseTime(evidence.observed_at, `${path}.evidence.observed_at`, errors);
  }

  let details = receipt.details;
  if (!isDict(details)) {
    errors.push(`${path}.details must be an object`);
    details = {};
  }
  if (receipt.policy_version !== POLICY_VERSION) errors.push(`${path}.policy_version must be ${POLICY_VERSION}`);

  if (receiptType === 'submission') {
    if (!nonempty(details.source_ref)) errors.push(`${path}.details.source_ref is required for submission`);
    if (!FINGERPRINT_RE.test(pystr(has(details, 'content_hash') ? details.content_hash : ''))) {
      errors.push(`${path}.details.content_hash is required for submission`);
    }
  } else if (receiptType === 'dedupe') {
    if (!WORK_ITEM_RE.test(pystr(has(details, 'canonical_work_item_id') ? details.canonical_work_item_id : ''))) {
      errors.push(`${path}.details.canonical_work_item_id is required for dedupe`);
    }
    if (details.decision !== 'linked' && details.decision !== 'distinct') {
      errors.push(`${path}.details.decision is invalid for dedupe`);
    }
    if (!FINGERPRINT_RE.test(pystr(has(details, 'fingerprint') ? details.fingerprint : ''))) {
      errors.push(`${path}.details.fingerprint is required for dedupe`);
    }
    const refs = details.source_refs;
    if (!Array.isArray(refs) || refs.length < 2 || new Set(refs.map(pystr)).size !== refs.length) {
      errors.push(`${path}.details.source_refs needs at least two unique refs`);
    }
  } else if (receiptType === 'assignment') {
    if (!nonempty(details.owner)) errors.push(`${path}.details.owner is required for assignment`);
    parseTime(details.lease_until, `${path}.details.lease_until`, errors);
    parseTime(details.next_check_at, `${path}.details.next_check_at`, errors);
    validateReturnRoute(details.return_route, `${path}.details.return_route`, errors);
  } else if (receiptType === 'execution') {
    if (!nonempty(details.dispatch_id)) errors.push(`${path}.details.dispatch_id is required for execution`);
    if (!nonempty(details.idempotency_key)) errors.push(`${path}.details.idempotency_key is required for execution`);
    // Python: isinstance(x, int) — and bool IS an int in Python, so True passes there.
    const exit = details.exit_status;
    const isPyInt = (typeof exit === 'boolean') || (typeof exit === 'number' && Number.isInteger(exit));
    if (!isPyInt) errors.push(`${path}.details.exit_status must be an integer`);
  } else if (receiptType === 'verification') {
    if (!nonempty(details.check)) errors.push(`${path}.details.check is required for verification`);
    if (isDict(actor) && actor.role !== 'verifier' && actor.role !== 'system') {
      errors.push(`${path}.actor.role must be verifier or system for verification`);
    }
    if (isDict(evidence) && !has(evidence, 'observed_at')) {
      errors.push(`${path}.evidence.observed_at is required for verification`);
    }
  } else if (receiptType === 'human_gate') {
    missingRequired(details, ['card_id', 'reason_code', 'recommendation', 'exact_action', 'return_route'],
      `${path}.details`, errors);
    if (!GATE_REASONS.has(details.reason_code)) errors.push(`${path}.details.reason_code is invalid`);
    for (const key of ['card_id', 'recommendation', 'exact_action']) {
      if (has(details, key) && !nonempty(details[key])) errors.push(`${path}.details.${key} must be non-empty`);
    }
    if (has(details, 'return_route')) {
      validateReturnRoute(details.return_route, `${path}.details.return_route`, errors);
    }
  } else if (receiptType === 'closure') {
    if (!TERMINAL_STATES.has(details.final_state)) errors.push(`${path}.details.final_state is invalid for closure`);
    const refs = details.verification_receipt_ids;
    if (!Array.isArray(refs) || refs.length === 0 || !refs.every((v) => RECEIPT_RE.test(pystr(v)))) {
      errors.push(`${path}.details.verification_receipt_ids must be non-empty`);
    }
  }
  return errors;
}

/** SCHEMA_CONTRACT. Returns { errors, observedAt }. */
function schemaErrors(data) {
  const errors = [];
  if (!isDict(data)) return { errors: ['input must be a JSON object'], observedAt: null };
  unknownKeys(data, TOP_LEVEL_KEYS, 'input', errors);
  for (const key of ['contract', 'mode', 'turn_id', 'surface', 'observed_at', 'work_items', 'receipts']) {
    if (!has(data, key)) errors.push(`input.${key} is required`);
  }
  if (data.contract !== INPUT_CONTRACT) errors.push(`input.contract must be ${INPUT_CONTRACT}`);
  if (data.mode !== 'feedback_ingress' && data.mode !== 'turn_close') {
    errors.push('input.mode must be feedback_ingress or turn_close');
  }
  if (!nonempty(data.turn_id)) errors.push('input.turn_id is required');
  if (!nonempty(data.surface)) errors.push('input.surface is required');
  const observedAt = parseTime(data.observed_at, 'input.observed_at', errors);
  for (const key of ['work_items', 'receipts', 'delegated_work', 'pulse_cards', 'claims']) {
    if (has(data, key) && !Array.isArray(data[key])) errors.push(`input.${key} must be an array`);
  }
  if (Array.isArray(data.work_items)) {
    data.work_items.forEach((item, i) => errors.push(...validateWorkItem(item, i, observedAt)));
  }
  if (Array.isArray(data.receipts)) {
    data.receipts.forEach((r, i) => errors.push(...validateReceipt(r, i)));
  }
  return { errors, observedAt };
}

/** WI1_IDENTITY_DEDUPE. */
function identityErrors(data) {
  const errors = [];
  const safe = isDict(data) ? data : {};
  const items = (Array.isArray(safe.work_items) ? safe.work_items : []).filter(isDict);
  const receipts = (Array.isArray(safe.receipts) ? safe.receipts : []).filter(isDict);

  const itemById = new Map();
  const sourceToId = new Map();
  const fingerprints = new Map();

  for (const item of items) {
    const itemId = item.work_item_id;
    if (itemById.has(itemId)) errors.push(`duplicate work_item_id ${pystr(itemId)}`);
    else if (nonempty(itemId)) itemById.set(itemId, item);
    const source = item.source_ref;
    if (sourceToId.has(source) && sourceToId.get(source) !== itemId) {
      errors.push(`source_ref ${pystr(source)} maps to multiple work items`);
    } else if (nonempty(source)) sourceToId.set(source, itemId);
    if (nonempty(item.fingerprint)) {
      if (!fingerprints.has(item.fingerprint)) fingerprints.set(item.fingerprint, []);
      fingerprints.get(item.fingerprint).push(item);
    }
  }

  const receiptById = new Map();
  const receiptsByItem = new Map();
  for (const receipt of receipts) {
    const receiptId = receipt.receipt_id;
    if (receiptById.has(receiptId)) errors.push(`duplicate receipt_id ${pystr(receiptId)}`);
    else if (nonempty(receiptId)) receiptById.set(receiptId, receipt);
    const itemId = receipt.work_item_id;
    if (!itemById.has(itemId)) {
      errors.push(`receipt ${pystr(receiptId)} references unknown work item ${pystr(itemId)}`);
    } else {
      if (!receiptsByItem.has(itemId)) receiptsByItem.set(itemId, []);
      receiptsByItem.get(itemId).push(receipt);
    }
  }

  for (const [itemId, item] of itemById) {
    const relatedIds = Array.isArray(item.related_ids) ? item.related_ids : [];
    for (const relatedId of relatedIds) {
      if (relatedId === itemId) errors.push(`work item ${itemId} cannot relate to itself`);
      else if (!itemById.has(relatedId)) errors.push(`work item ${itemId} relates to unknown ${pystr(relatedId)}`);
    }
    const receiptIds = Array.isArray(item.receipt_ids) ? item.receipt_ids : [];
    for (const receiptId of receiptIds) {
      const receipt = receiptById.get(receiptId);
      if (!receipt) errors.push(`work item ${itemId} links unknown receipt ${pystr(receiptId)}`);
      else if (receipt.work_item_id !== itemId) {
        errors.push(`work item ${itemId} links receipt ${pystr(receiptId)} owned by another item`);
      }
    }
    const mine = receiptsByItem.get(itemId) || [];
    const unlinked = mine
      .filter((r) => !receiptIds.includes(r.receipt_id))
      .map((r) => r.receipt_id)
      .sort();
    if (unlinked.length) errors.push(`work item ${itemId} omits receipts: ${unlinked.join(', ')}`);

    const submissions = mine.filter((r) => r.type === 'submission');
    const sourceRefs = new Set();
    for (const r of submissions) {
      const v = isDict(r.details) ? r.details.source_ref : undefined;
      if (v !== undefined && v !== null) sourceRefs.add(v);
    }
    if (sourceRefs.size > 1) {
      const dedupe = mine.filter((r) => {
        const d = isDict(r.details) ? r.details : {};
        return r.type === 'dedupe' && r.status === 'pass' && d.decision === 'linked'
          && d.canonical_work_item_id === itemId && d.fingerprint === item.fingerprint;
      });
      const covered = dedupe.some((r) => {
        const d = isDict(r.details) ? r.details : {};
        const refs = new Set(Array.isArray(d.source_refs) ? d.source_refs : []);
        return [...sourceRefs].every((s) => refs.has(s));
      });
      if (!dedupe.length || !covered) {
        errors.push(`work item ${itemId} has multiple submissions without a covering dedupe receipt`);
      }
    }
  }

  for (const [fingerprint, group] of fingerprints) {
    if (group.length < 2) continue;
    const active = group.filter((i) => !['declined', 'superseded', 'closed'].includes(i.state));
    const canonicalId = active.length === 1 ? active[0].work_item_id : null;
    const linked = receipts.filter((r) => {
      const d = isDict(r.details) ? r.details : {};
      return r.type === 'dedupe' && r.status === 'pass' && d.decision === 'linked'
        && d.fingerprint === fingerprint && d.canonical_work_item_id === canonicalId;
    });
    if (!canonicalId || !linked.length) {
      const ids = group.map((i) => pystr(i.work_item_id)).join(', ');
      errors.push(`fingerprint ${fingerprint} has competing work items: ${ids}`);
    }
    for (const item of group) {
      if (canonicalId && item.work_item_id !== canonicalId) {
        const related = Array.isArray(item.related_ids) ? item.related_ids : [];
        if (item.state !== 'superseded' || !related.includes(canonicalId)) {
          errors.push(`duplicate work item ${pystr(item.work_item_id)} is not superseded by ${canonicalId}`);
        }
      }
    }
  }
  return errors;
}

/**
 * Mirrors soma_invariant_gate.py `_rule()` EXACTLY, including the details that
 * look cosmetic and are not: falsy errors are dropped, duplicates are removed
 * preserving first-seen order (`dict.fromkeys`), `evidence` is the joined list
 * and `message` is only the FIRST error, and both are truncated at 2048 chars.
 * Getting `message` wrong here would have silently changed what an operator sees.
 */
function rule(name, errors, passMessage) {
  const unique = [...new Set(errors.filter(Boolean))];
  if (unique.length) {
    return {
      rule: name,
      result: 'fail',
      evidence: unique.join('; ').slice(0, 2048),
      message: unique[0].slice(0, 2048),
    };
  }
  return { rule: name, result: 'pass', evidence: passMessage, message: passMessage };
}

/**
 * Evaluate the deterministic subset.
 * @returns {{deterministic: object[], decision: 'allow'|'repair', ported: string[], not_ported: string[]}}
 */
function evaluateDeterministic(data) {
  const { errors: schema } = schemaErrors(data);
  const safe = isDict(data) ? data : {};
  const results = [
    rule('SCHEMA_CONTRACT', schema, 'v1 input, work items, and receipts validate'),
    rule('WI1_IDENTITY_DEDUPE', identityErrors(safe),
      'work-item, source, fingerprint, and dedupe links reconcile'),
  ];
  return {
    policy_version: POLICY_VERSION,
    deterministic: results,
    decision: results.some((r) => r.result === 'fail') ? 'repair' : 'allow',
    ported: ['SCHEMA_CONTRACT', 'WI1_IDENTITY_DEDUPE'],
    not_ported: ['OS1_OWNER_LEASE_RETURN', 'TC2_SUBORDINATE_CLOSURE',
      'TC3_EXECUTABLE_GATE', 'TC4_CLAIM_EVIDENCE', 'TC5_NO_SILENT_WORK'],
  };
}

module.exports = {
  POLICY_VERSION,
  INPUT_CONTRACT,
  schemaErrors,
  identityErrors,
  evaluateDeterministic,
};
