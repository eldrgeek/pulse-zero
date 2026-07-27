// card-comment-webhook.js — instant-answer trigger for Pulse Zero comments.
//
// Called by a Postgres trigger (public.notify_card_comment_insert, see
// supabase/migrations/20260726b_step_state_and_comment_webhook.sql) via
// pg_net immediately after any INSERT on public.pulse_card_comments. This
// replaces waiting for pulse-answer's 20-30min poll for the common case —
// the poll stays running as the safety net for anything this path misses
// (function cold-start failure, pg_net delivery failure, etc).
//
// Only comments authored by 'mike' should trigger a dispatch (mirrors
// pulse-answer's own filter) — otherwise Dee's own reply comment would
// re-trigger itself in a loop. Auth: shared secret in Supabase Vault
// (name='pulse_webhook_secret') must match this function's
// PULSE_WEBHOOK_SECRET env var (set via `netlify env:set` on this site).
const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const expected = process.env.PULSE_WEBHOOK_SECRET;
  const got = event.headers['x-pulse-secret'] || event.headers['X-Pulse-Secret'];
  if (!expected || got !== expected) {
    return { statusCode: 401, body: JSON.stringify({ error: 'bad secret' }) };
  }

  const serviceKey = process.env.PULSE_ZERO_SERVICE_KEY;
  if (!serviceKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'PULSE_ZERO_SERVICE_KEY not set' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON' }) };
  }

  const { comment_id, card_id, author } = body;
  if (!comment_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'comment_id required' }) };
  }

  // Only Mike's own comments should dispatch a worker — a reply comment
  // (author='dee' or anything else) inserting itself must NOT re-trigger.
  if (author !== 'mike') {
    return { statusCode: 200, body: JSON.stringify({ status: 'skipped', reason: 'author is not mike', author }) };
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
      body: JSON.stringify({
        command: 'answer_card_comment',
        payload: { comment_id, card_id },
        status: 'open',
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return { statusCode: resp.status, body: JSON.stringify({ error: errText }) };
    }
    const rows = await resp.json();
    return { statusCode: 200, body: JSON.stringify({ status: 'queued', mac_command_id: rows[0]?.id }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
