const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(
  __dirname, '..', 'supabase', 'migrations', '20260801_executable_queue_v1.sql',
), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('migration is additive and legacy-safe by default', () => {
  assert.match(sql, /queue_state text not null default 'legacy'/);
  assert.match(sql, /queue_position is null or queue_position between 1 and 5/);
  assert.match(sql, /pulse_one_card_per_queue_position/);
  assert.match(sql, /where c\.app_id = 'pulse-zero' and c\.queue_state = 'queued'/);
});

test('server-authoritative enqueue accepts identifiers and re-reads stored action', () => {
  assert.match(sql, /function public\.enqueue_pulse_action\([\s\S]*p_card_id uuid[\s\S]*p_action_id text/);
  assert.match(sql, /from jsonb_array_elements\(v_card\.payload->'actions'\)/);
  assert.match(sql, /'action', v_action/);
  assert.doesNotMatch(sql, /p_action jsonb/);
  assert.match(sql, /action operation is not reviewed/);
});

test('queue UI is opt-in and uses the bounded server projection', () => {
  assert.match(html, /get\('queue_v1'\) === '1'/);
  assert.match(html, /from\('pulse_active_queue_v1'\)[\s\S]*limit\(5\)/);
  assert.match(html, /rpc\('enqueue_pulse_action'/);
  assert.match(html, /if \(c\.queue_state === 'queued'\)/);
  assert.match(html, /Compatibility path for pre-queue typed cards/);
});

test('verified actions and direct judgment both require continuation', () => {
  assert.match(sql, /start_pulse_continuation_v1/);
  assert.match(sql, /answer_pulse_gate_v1/);
  assert.match(sql, /acknowledge_pulse_continuation_v1/);
  assert.match(sql, /auth\.role\(\) <> 'service_role'/);
});
