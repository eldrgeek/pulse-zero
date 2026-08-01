// Pulse Zero adapter for the canonical SOMA invariant command.
//
// This module owns no policy. It normalizes feedback ingress into the shared
// contract and optionally invokes a caller-supplied command in shadow mode.
// The production function remains unchanged unless SOMA_INVARIANT_SHADOW=1,
// and a shadow failure is diagnostic only.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

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

function runShadow(envelope, options = {}) {
  const env = options.env || process.env;
  if (env.SOMA_INVARIANT_SHADOW !== '1') {
    return { status: 'disabled' };
  }
  const command = env.SOMA_INVARIANT_GATE;
  if (!command) {
    return { status: 'degraded', error: 'SOMA_INVARIANT_GATE is not configured' };
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
        error: String(result.error || result.stderr || `exit ${result.status}`).trim(),
      };
    }
    return { status: 'evaluated', decision: JSON.parse(result.stdout) };
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

