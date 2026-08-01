const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildFeedbackEnvelope,
  feedbackFingerprint,
  runShadow,
  workItemIdForFingerprint,
} = require('../netlify/functions/soma-invariant-shadow');

function feedback(overrides = {}) {
  return {
    site: 'pulse-zero',
    page: 'Needs Mike',
    url: 'https://pulse-zero.netlify.app/#queue',
    area: 'board',
    text: 'The card title overlaps the action button.',
    name: 'Reporter',
    email: 'reporter@example.test',
    conversation: null,
    status: 'new',
    ...overrides,
  };
}

test('exact reports get one stable work item but distinct submission receipts', () => {
  const filedAt = '2026-08-01T16:00:00Z';
  const first = buildFeedbackEnvelope(feedback(), { id: 'row-a' }, filedAt);
  const second = buildFeedbackEnvelope(feedback(), { id: 'row-b' }, filedAt);
  assert.equal(first.work_items[0].work_item_id, second.work_items[0].work_item_id);
  assert.equal(first.work_items[0].fingerprint, second.work_items[0].fingerprint);
  assert.notEqual(first.receipts[0].receipt_id, second.receipts[0].receipt_id);
  assert.notEqual(first.receipts[0].details.source_ref, second.receipts[0].details.source_ref);
});

test('new scope on the same target creates a different work item', () => {
  const first = feedback();
  const second = feedback({ text: 'The action should also expose its verification result.' });
  const firstFingerprint = feedbackFingerprint(first);
  const secondFingerprint = feedbackFingerprint(second);
  assert.notEqual(firstFingerprint, secondFingerprint);
  assert.notEqual(workItemIdForFingerprint(firstFingerprint), workItemIdForFingerprint(secondFingerprint));
});

test('fingerprint ignores reporter identity and fragment-only navigation', () => {
  const first = feedback();
  const second = feedback({
    name: 'Another Reporter',
    email: 'another@example.test',
    url: 'https://pulse-zero.netlify.app/#history',
  });
  assert.equal(feedbackFingerprint(first), feedbackFingerprint(second));
});

test('shadow is off by default and does not invoke a process', () => {
  let invoked = false;
  const result = runShadow({}, {
    env: {},
    spawn: () => { invoked = true; },
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(invoked, false);
});

test('enabled shadow passes the canonical envelope through non-blocking mode', () => {
  const envelope = buildFeedbackEnvelope(feedback(), { id: 'row-a' }, '2026-08-01T16:00:00Z');
  let call;
  const result = runShadow(envelope, {
    env: { SOMA_INVARIANT_SHADOW: '1', SOMA_INVARIANT_GATE: '/mock/gate' },
    spawn: (command, args, options) => {
      call = { command, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({ decision: 'allow', evaluation_id: 'inv_123' }),
        stderr: '',
      };
    },
  });
  assert.equal(result.status, 'evaluated');
  assert.deepEqual(call.args, ['check', '--input', '-', '--enforcement', 'shadow']);
  assert.equal(JSON.parse(call.options.input).contract, 'soma-invariant-check-input/1');
});

test('shadow command failure is visible but never throws', () => {
  const result = runShadow({}, {
    env: { SOMA_INVARIANT_SHADOW: '1', SOMA_INVARIANT_GATE: '/mock/gate' },
    spawn: () => ({ status: 7, stdout: '', stderr: 'not available' }),
  });
  assert.equal(result.status, 'degraded');
  assert.match(result.error, /not available/);
});

test('canonical SOMA kernel accepts the normalized feedback ingress', (t) => {
  const gate = path.resolve(__dirname, '../../SOMA/tools/soma-invariant-gate');
  if (!fs.existsSync(gate)) {
    t.skip('canonical SOMA sibling is not checked out');
    return;
  }
  const envelope = buildFeedbackEnvelope(feedback(), { id: 'row-canonical' }, '2026-08-01T16:00:00Z');
  const result = runShadow(envelope, {
    env: { SOMA_INVARIANT_SHADOW: '1', SOMA_INVARIANT_GATE: gate },
  });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.decision.decision, 'allow');
});
