const test = require('node:test');
const assert = require('node:assert/strict');

const { handler } = require('../netlify/functions/feedback');

test.beforeEach(() => {
  process.env.PULSE_ZERO_SERVICE_KEY = 'test-service-key';
  delete process.env.SOMA_INVARIANT_SHADOW;
  delete process.env.SOMA_INVARIANT_GATE;
});

test.afterEach(() => {
  delete process.env.PULSE_ZERO_SERVICE_KEY;
  delete process.env.SOMA_INVARIANT_SHADOW;
  delete process.env.SOMA_INVARIANT_GATE;
  delete global.fetch;
});

test('accepted feedback returns stable work-item and submission receipt identities', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => [{ id: 'row-feedback-0001' }],
  });
  const result = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      site: 'pulse-zero',
      page: 'Needs Mike',
      url: 'https://pulse-zero.netlify.app/',
      area: 'board',
      text: 'The card title overlaps the action button.',
    }),
  });
  const response = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(response.status, 'accepted');
  assert.match(response.work_item_id, /^wi_feedback_[a-f0-9]{24}$/);
  assert.match(response.submission_receipt_id, /^rcpt_submission_[a-f0-9]{24}$/);
  assert.match(response.fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('database errors preserve the existing response behavior', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'database unavailable',
  });
  const result = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ text: 'A valid feedback report.' }),
  });
  assert.equal(result.statusCode, 503);
  assert.match(JSON.parse(result.body).error, /database unavailable/);
});

