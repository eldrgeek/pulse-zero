const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PulseQueue = require('../public/pulse-queue.js');
const PulseActions = require('../public/pulse-actions.js');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'queue-v1-consent.json'), 'utf8',
));
const fixtureRegistry = {
  'workflow/fixture_consent_gate': {
    verificationKinds: ['fixture_state'],
    targetRefs: ['fixture.consent.approve'],
    targetHosts: ['consent.fixture.invalid'],
  },
};
const options = { now: new Date('2026-08-01T13:00:00Z'), operationRegistry: fixtureRegistry };

function card(id, overrides = {}) {
  return {
    ...structuredClone(fixture),
    id,
    dedupe_key: `gate-${id}`,
    payload: structuredClone(fixture.payload),
    gate_contract: structuredClone(fixture.gate_contract),
    continuation_contract: structuredClone(fixture.continuation_contract),
    ...overrides,
  };
}

test('deterministic fixture is queue eligible without external execution', () => {
  assert.deepEqual(PulseQueue.baseEligibilityErrors(fixture, options), []);
});

test('ranking is lexicographic and creation recency is not a rank signal', () => {
  const oldLegends = card('a', {
    mission_lane: 'legends', eligible_at: '2026-08-01T10:00:00Z', created_at: '2020-01-01T00:00:00Z',
  });
  const newOther = card('b', {
    mission_lane: 'other', eligible_at: '2026-08-01T09:00:00Z', created_at: '2030-01-01T00:00:00Z',
  });
  const deadline = card('c', {
    priority_band: 0, deadline_at: '2026-08-02T00:00:00Z', mission_lane: 'other',
  });
  const ranked = PulseQueue.rankQueue([newOther, oldLegends, deadline], options).queue;
  assert.deepEqual(ranked.map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(ranked.map(item => item.queue_position), [1, 2, 3]);
});

test('duplicates and invalid contracts are held, not allowed to compete', () => {
  const first = card('a', { dedupe_key: 'same-gate', eligible_at: '2026-08-01T09:00:00Z' });
  const duplicate = card('b', { dedupe_key: 'same-gate', eligible_at: '2026-08-01T10:00:00Z' });
  const invalid = card('c');
  delete invalid.payload.actions;
  const result = PulseQueue.rankQueue([duplicate, invalid, first], options);
  assert.deepEqual(result.queue.map(item => item.id), ['a']);
  assert(result.holds.find(item => item.card.id === 'b').errors.some(e => e.code === 'duplicate_gate'));
  assert(result.holds.find(item => item.card.id === 'c').errors.some(e => e.code === 'typed_action_required'));
});

test('queue is bounded to five with unique materialized positions', () => {
  const cards = Array.from({ length: 9 }, (_, index) => card(String(index + 1), {
    blocked_work_count: 9 - index,
  }));
  const result = PulseQueue.rankQueue(cards, options);
  assert.equal(result.queue.length, 5);
  assert.equal(result.overflow.length, 4);
  assert.deepEqual(result.queue.map(item => item.queue_position), [1, 2, 3, 4, 5]);
});

test('execution state advances only after target-ready, verification, and continuation', () => {
  assert.equal(PulseQueue.executionState(null, null), 'ready');
  assert.equal(PulseQueue.executionState({ status: 'open', result: { state: 'running' } }, null), 'team_preparing');
  assert.equal(PulseQueue.executionState({
    status: 'open', result: { state: 'waiting_human', human_gate: { target_ready: false } },
  }, null), 'team_preparing');
  const waiting = { status: 'open', result: { state: 'waiting_human', human_gate: { target_ready: true } } };
  assert.equal(PulseQueue.executionState(waiting, null), 'your_turn');
  const verified = { status: 'done', result: { verified: true } };
  assert.equal(PulseQueue.executionState(verified, { status: 'running' }), 'team_resuming');
  assert.equal(PulseQueue.executionState(verified, { status: 'verifying' }), 'verifying');
  assert.equal(PulseQueue.executionState(verified, { status: 'succeeded' }), 'cleared');
  assert.equal(PulseQueue.executionState({ status: 'done', result: { verified: false } }, null), 'could_not_verify');
});

test('legacy cards stay compatible but cannot enter the active queue accidentally', () => {
  const legacy = card('legacy', { queue_state: 'legacy' });
  assert(PulseQueue.baseEligibilityErrors(legacy, options).some(e => e.code === 'queue_not_opted_in'));

  const action = fixture.payload.actions[0];
  const legacyRow = PulseActions.buildCommandRow({ id: 'legacy' }, action, 1);
  assert.deepEqual(legacyRow.payload.action, action);
  const queueArgs = PulseActions.enqueueRpcArgs({ id: 'queued' }, action, 1);
  assert.deepEqual(queueArgs, {
    p_card_id: 'queued', p_action_id: 'approve-fixture', p_revision: 1, p_attempt: 1,
  });
  assert(!Object.hasOwn(queueArgs, 'action'));
});

test('unsupported operations and legacy Yeshie prose do not satisfy queue eligibility', () => {
  const unsupported = card('unsupported');
  unsupported.payload.actions[0].operation = 'run_yeshie_recipe';
  unsupported.yeshie_task = { recipe_path: 'arbitrary/path.json' };
  const errors = PulseQueue.baseEligibilityErrors(unsupported, options);
  assert(errors.some(e => e.code === 'unsupported_operation'));
});

test('reviewed GitHub operation validates against the canonical queue registry', () => {
  const github = card('github');
  github.gate_contract.target = {
    surface: 'web', label: 'Accept invitation',
    url: 'https://github.com/orgs/FixtureOrg/invitation',
    ref: 'github.org_invitation.accept',
  };
  github.payload.actions[0] = {
    ...github.payload.actions[0],
    operation: 'github_accept_org_invite',
    params: { org: 'FixtureOrg', username: 'fixture-user' },
    verification: { kind: 'github_org_membership', params: {} },
    human_gate: {
      instruction: 'Click the highlighted invitation control.',
      target: {
        url: 'https://github.com/orgs/FixtureOrg/invitation',
        ref: 'github.org_invitation.accept',
        label: 'Accept invitation',
      },
    },
  };
  assert.deepEqual(PulseQueue.baseEligibilityErrors(github, {
    now: options.now,
    operationRegistry: PulseQueue.DEFAULT_OPERATION_REGISTRY,
  }), []);
});
