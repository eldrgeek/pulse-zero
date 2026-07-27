const test = require('node:test');
const assert = require('node:assert/strict');

const { handler } = require('../netlify/functions/pulse-agent-session');

function event(token = 'valid-token') {
  return { httpMethod: 'GET', headers: { authorization: `Bearer ${token}` } };
}

test.beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = 'server-only-key';
});

test.afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  delete global.fetch;
});

test('rejects requests without a Pulse session', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; };
  const result = await handler({ httpMethod: 'GET', headers: {} });
  assert.equal(result.statusCode, 401);
  assert.equal(fetchCalled, false);
});

test('fails closed when the server key is absent', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  global.fetch = async () => { throw new Error('must not fetch'); };
  const result = await handler(event());
  assert.equal(result.statusCode, 503);
});

test('rejects an authenticated user who is not Mike', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ email: 'someone@example.com' }),
  });
  const result = await handler(event());
  assert.equal(result.statusCode, 403);
});

test('returns a signed URL only after Supabase verifies Mike', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ email: 'mw@mike-wolf.com' }) };
    }
    return {
      ok: true,
      json: async () => ({ signed_url: 'wss://signed.example/session' }),
    };
  };

  const result = await handler(event());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), {
    signed_url: 'wss://signed.example/session',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer valid-token');
  assert.equal(calls[1].options.headers['xi-api-key'], 'server-only-key');
});

test('does not expose ElevenLabs upstream errors', async () => {
  global.fetch = async (url) => {
    if (url.includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ email: 'mw@mike-wolf.com' }) };
    }
    return { ok: false, status: 401, text: async () => 'secret diagnostic' };
  };
  const result = await handler(event());
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.includes('secret diagnostic'), false);
});
