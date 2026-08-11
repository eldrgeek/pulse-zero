// Pulse Zero adapter for the canonical SOMA invariant command.
//
// This module owns no policy. It normalizes feedback ingress into the shared
// contract and optionally invokes a caller-supplied command in shadow mode.
// The production function remains unchanged unless SOMA_INVARIANT_SHADOW=1,
// and a shadow failure is diagnostic only.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { evaluateDeterministic } = require('./lib/soma-invariant-deterministic.js');

const POLICY_VERSION = 'soma-invariants/1';
const INPUT_CONTRACT = 'soma-invariant-check-input/1';

function normalizedText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function normalizedUrl(value) {
  const raw = normalizedText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return raw;
  }
}

function feedbackFingerprint(row) {
  const identity = {
    site: normalizedText(row.site).toLowerCase(),
    page: normalizedText(row.page),
    url: normalizedUrl(row.url),
    area: normalizedText(row.area).toLowerCase(),
    text: normalizedText(row.text),
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return `sha256:${digest}`;
}

function workItemIdForFingerprint(fingerprint) {
  const digest = String(fingerprint).replace(/^sha256:/, '');
  return `wi_feedback_${digest.slice(0, 24)}`;
}

function receiptIdForSource(sourceRef) {
  const digest = crypto.createHash('sha256').update(sourceRef).digest('hex');
  return `rcpt_submission_${digest.slice(0, 24)}`;
}

function buildFeedbackEnvelope(row, insertedRow, filedAt) {
  const fingerprint = feedbackFingerprint(row);
  const workItemId = workItemIdForFingerprint(fingerprint);
  const rowId = insertedRow && insertedRow.id
    ? String(insertedRow.id)
    : `unreturned-${crypto.randomUUID()}`;
  const sourceRef = `pulse-zero:feedback:${rowId}`;
  const receiptId = receiptIdForSource(sourceRef);
  return {
    contract: INPUT_CONTRACT,
    mode: 'feedback_ingress',
    turn_id: sourceRef,
    surface: 'pulse-zero',
    observed_at: filedAt,
    work_items: [
      {
        work_item_id: workItemId,
        kind: 'feedback',
        source_ref: sourceRef,
        fingerprint,
        state: 'submitted',
        related_ids: [],
        receipt_ids: [receiptId],
        policy_version: POLICY_VERSION,
      },
    ],
    receipts: [
      {
        receipt_id: receiptId,
        work_item_id: workItemId,
        type: 'submission',
        issued_at: filedAt,
        actor: { id: 'feedback-reporter', role: 'reporter' },
        scope: {
          subject: sourceRef,
          environment: 'not_applicable',
          assertions: ['submission_accepted'],
        },
        status: 'pass',
        evidence: {
          kind: 'database_row',
          ref: `pulse_zero_feedback/${rowId}`,
          observed_at: filedAt,
        },
        details: {
          source_ref: sourceRef,
          content_hash: fingerprint,
        },
        policy_version: POLICY_VERSION,
      },
    ],
    delegated_work: [],
    pulse_cards: [],
    claims: [],
  };
}

/**
 * WQ-251 (2026-08-11). Previously this function had exactly one path: spawn the
 * Python gate. Netlify's function runtime has no python3 and no way to ship one,
 * so in production that spawn ALWAYS failed and this adapter could only ever
 * return {status:'degraded'} — which is why SOMA_INVARIANT_SHADOW had to stay
 * unset in prod and the shadow has never observed a single real ingress.
 *
 * Now the deterministic rules (SCHEMA_CONTRACT, WI1_IDENTITY_DEDUPE) run in
 * process from ./lib/soma-invariant-deterministic.js, verified byte-identical to
 * the Python gate across 20 shared fixtures by
 * test/invariant-js-conformance.test.js. SOMA_INVARIANT_GATE remains supported
 * and still WINS when set, because it is the full rule set; the JS path is the
 * deterministic subset and says so in `coverage`.
 */
function runShadow(envelope, options = {}) {
  const env = options.env || process.env;
  if (env.SOMA_INVARIANT_SHADOW !== '1') {
    return { status: 'disabled' };
  }
  const command = env.SOMA_INVARIANT_GATE;
  if (!command) {
    try {
      const local = evaluateDeterministic(envelope);
      return {
        status: 'evaluated',
        coverage: 'deterministic-subset',
        engine: 'js',
        decision: {
          policy_version: local.policy_version,
          turn_id: String(envelope && envelope.turn_id ? envelope.turn_id : 'invalid-input'),
          enforcement: 'shadow',
          blocking: false,
          deterministic: local.deterministic,
          judgment: [],
          decision: local.decision,
          not_evaluated: local.not_ported,
        },
      };
    } catch (error) {
      return { status: 'degraded', engine: 'js', error: error.message };
    }
  }
  const spawn = options.spawn || spawnSync;
  try {
    const result = spawn(
      command,
      ['check', '--input', '-', '--enforcement', 'shadow'],
      {
        input: JSON.stringify(envelope),
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error || result.status !== 0) {
      return {
        status: 'degraded',
        engine: 'python',
        error: String(result.error || result.stderr || `exit ${result.status}`).trim(),
      };
    }
    return { status: 'evaluated', coverage: 'full', engine: 'python', decision: JSON.parse(result.stdout) };
  } catch (error) {
    return { status: 'degraded', error: error.message };
  }
}

module.exports = {
  POLICY_VERSION,
  INPUT_CONTRACT,
  normalizedText,
  feedbackFingerprint,
  workItemIdForFingerprint,
  receiptIdForSource,
  buildFeedbackEnvelope,
  runShadow,
};

