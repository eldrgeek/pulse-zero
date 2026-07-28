const test = require('node:test');
const assert = require('node:assert/strict');

const PulseActions = require('../public/pulse-actions.js');

function validAction(overrides = {}) {
  return {
    id: 'approve-release',
    revision: 1,
    executor: 'web',
    label: 'Review and approve',
    description: 'Yeshie opens the exact approval control.',
    operation: 'run_yeshie_recipe',
    params: { recipe: { runId: 'release-approval', chain: [] } },
    human_gate: {
      instruction: 'On the Mac, review the release and click Approve.',
      target: {
        url: 'https://deploy.example.com/releases/123',
        ref: 'approve-release-button',
        label: 'Approve',
      },
    },
    completion: {
      mode: 'verified',
      success_message: 'Release approval verified.',
      close_card: true,
    },
    verification: {
      kind: 'target_state',
      params: { state: 'approved' },
    },
    ...overrides,
  };
}

test('payload.actions v1 accepts a complete family-agnostic action', () => {
  const action = validAction();
  const parsed = PulseActions.parsePayload({ actions_version: 1, actions: [action] });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.actions, [action]);
});

test('contract rejects duplicate ids and a Mac human gate', () => {
  const mac = validAction({ executor: 'mac' });
  const parsed = PulseActions.parsePayload({ actions_version: 1, actions: [mac, mac] });
  assert.equal(parsed.actions.length, 0);
  assert(parsed.errors.some(error => error.includes('human_gate is only valid')));
  assert(parsed.errors.some(error => error.includes('duplicates approve-release')));
});

test('human gate requires an exact https Yeshie target reference', () => {
  const action = validAction({
    human_gate: {
      instruction: 'Click the highlighted control.',
      target: { url: 'http://deploy.example.com', ref: '', label: '' },
    },
  });
  const parsed = PulseActions.parsePayload({ actions_version: 1, actions: [action] });
  assert(parsed.errors.some(error => error.includes('absolute https URL')));
  assert(parsed.errors.some(error => error.includes('abstract target')));
  assert(parsed.errors.some(error => error.includes('target.label is required')));
});

test('command envelope carries executor contract and stable idempotency metadata', () => {
  const card = { id: '9e356453-e286-404d-b796-4a795dd67190' };
  const action = validAction();
  const row = PulseActions.buildCommandRow(card, action, 2);
  const expectedKey = 'pulse-zero:9e356453-e286-404d-b796-4a795dd67190:approve-release:r1:a2';
  assert.equal(row.command, 'execute_card_action');
  assert.equal(row.status, 'open');
  assert.equal(row.pulse_card_id, card.id);
  assert.equal(row.pulse_action_id, action.id);
  assert.equal(row.pulse_revision, 1);
  assert.equal(row.attempt, 2);
  assert.equal(row.idempotency_key, expectedKey);
  assert.equal(row.payload.idempotency_key, expectedKey);
  assert.deepEqual(row.payload.action, action);
});

test('open command surfaces broker waiting_human state and resumes same attempt', () => {
  const action = validAction();
  const run = {
    id: 41,
    status: 'open',
    result: { state: 'waiting_human', safe_message: 'Approve is highlighted on the Mac.' },
    pulse_card_id: 'card-1',
    pulse_action_id: action.id,
    pulse_revision: 1,
    attempt: 1,
  };
  assert.equal(PulseActions.runPhase(run), 'waiting_human');
  assert.equal(PulseActions.safeResultMessage(run, action), 'Approve is highlighted on the Mac.');
  assert.equal(PulseActions.nextAttempt(null), 1);
  assert.equal(PulseActions.nextAttempt(run), 2);
});

test('done requires an explicit verified receipt', () => {
  const action = validAction();
  assert.equal(PulseActions.runPhase({ status: 'done', result: { verified: true } }), 'verified');
  const unverified = { status: 'done', result: { error: 'secret-bearing raw executor output' } };
  assert.equal(PulseActions.runPhase(unverified), 'failed');
  assert.equal(
    PulseActions.safeResultMessage(unverified, action),
    'This action did not complete safely. Use Ask Pulse to diagnose before retrying.',
  );
  assert(!PulseActions.safeResultMessage(unverified, action).includes('secret-bearing'));
});

test('latest receipt is selected by revision and highest attempt', () => {
  const action = validAction({ revision: 3 });
  const runs = [
    { id: 1, pulse_card_id: 'card-1', pulse_action_id: action.id, pulse_revision: 2, attempt: 9 },
    { id: 2, pulse_card_id: 'card-1', pulse_action_id: action.id, pulse_revision: 3, attempt: 1 },
    { id: 3, pulse_card_id: 'card-1', pulse_action_id: action.id, pulse_revision: 3, attempt: 2 },
  ];
  assert.equal(PulseActions.latestRun(runs, 'card-1', action).id, 3);
});
