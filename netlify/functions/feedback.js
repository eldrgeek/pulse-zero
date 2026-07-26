// feedback.js — Pulse Zero's own soma-feedback (SOMA-APP-STANDARD §8) backend.
// Pulse Zero has its own auth/backend (Netlify functions + its own tables in the
// shared Supabase project), so per §15's "app with its own auth" adoption path
// this does NOT route through the shared VPS feedback-svc. Stubbed as
// "all feedback -> review queue" (no clarity loop, no admin-build fast path yet):
// every accepted submission lands in public.pulse_zero_feedback with status='new'.
// See pulse-zero/README.md "Feedback" section for what's stubbed vs complete.
const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) };
  }

  const serviceKey = process.env.PULSE_ZERO_SERVICE_KEY;
  if (!serviceKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'PULSE_ZERO_SERVICE_KEY not set' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'invalid JSON' }) };
  }

  // honeypot — silently "accept" without writing a row
  if (body.hp) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ status: 'accepted', filedAt: new Date().toISOString(), build: false }) };
  }

  const text = (body.text || '').trim();
  if (!text) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'text required' }) };
  }

  const row = {
    site: body.site || 'pulse-zero',
    page: body.page || null,
    url: body.url || null,
    area: body.area || null,
    text,
    name: body.name || null,
    email: body.email || null,
    conversation: body.conversation || null,
    status: 'new',
  };

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/pulse_zero_feedback`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return { statusCode: resp.status, headers: cors, body: JSON.stringify({ error: errText }) };
    }
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ status: 'accepted', filedAt: new Date().toISOString(), build: false }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
