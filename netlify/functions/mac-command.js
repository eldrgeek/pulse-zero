// mac-command.js — voice-triggered Mac action, filed to the pulse-mac-bridge
// daemon's queue (~/Projects/pulse-mac-bridge, table public.mac_commands).
// The daemon polls that table, opens the page in debug Chrome, and speaks
// the steps aloud — see pulse-mac-bridge/README.md for the full contract.
const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Pulse-Secret',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) };
  }

  const expected = process.env.PULSE_TOOL_SECRET;
  const got = event.headers['x-pulse-secret'] || event.headers['X-Pulse-Secret'];
  if (expected && got !== expected) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'bad secret' }) };
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
  const { command, url, steps, text, title, voice_id } = body;
  if (!command) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'command required' }) };
  }

  let payload;
  if (command === 'open') {
    payload = { url };
  } else if (command === 'speak') {
    payload = { text, ...(voice_id ? { voice_id } : {}) };
  } else if (command === 'open_and_guide') {
    payload = {
      url,
      steps: Array.isArray(steps) ? steps : String(steps || '').split('\n').filter(Boolean),
      ...(title ? { title } : {}),
      ...(voice_id ? { voice_id } : {}),
    };
  } else {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `unknown command: ${command}` }) };
  }

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/mac_commands`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ command, payload, status: 'open' }),
    });
    if (!resp.ok) {
      const text2 = await resp.text();
      return { statusCode: resp.status, headers: cors, body: JSON.stringify({ error: text2 }) };
    }
    const rows = await resp.json();
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ status: 'queued', id: rows[0]?.id }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
