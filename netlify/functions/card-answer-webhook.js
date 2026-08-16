// card-answer-webhook.js — instant act-on-answer trigger for Pulse Zero.
//
// Called by a Postgres trigger (public.notify_card_answer_update, see
// supabase/migrations/20260817_pulse_one.sql) via pg_net immediately after
// any UPDATE on public.pulse_cards whose status lands on answered/resolved/
// retired/bounced. Clone of card-comment-webhook.js — same secret, same
// mac_commands transport — because that path has run rock-solid (~6s
// dispatch) since 2026-07-26, unlike the flapping pulse-realtime-watch
// websocket subscriber it replaces (109 CHANNEL_ERROR exits since 08-13).
//
// Two writes, both synchronous in this handler so the card strip's first
// narration line never depends on worker cooperation:
//   1. pulse_run_events: the deterministic "✓ consent received — dispatching"
//      row (or the terminal-status equivalent for retired/bounced, which
//      have no worker to dispatch — see status branch below).
//   2. mac_commands: an `act_on_answer` row the bridge's 2s poll picks up,
//      which shells to `pulse-act --commit` (single source of truth for the
//      dedup/skip logic already proven in that script).
const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';

// Terminal statuses with no worker to dispatch — retired/bounced are Mike
// declining or the steward killing an ask. They still get a narration event
// (so the strip shows *something* rather than silently vanishing) but no
// mac_commands row: dispatching a Haiku worker to "act on" a decline would
// be acting against the decision, not on it.
const NO_DISPATCH_STATUSES = new Set(['retired', 'bounced']);

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
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON' }) }; }
  const { card_id, status, run_id } = body;
  if (!card_id) return { statusCode: 400, body: JSON.stringify({ error: 'card_id required' }) };
  if (!status) return { statusCode: 400, body: JSON.stringify({ error: 'status required' }) };

  const restHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  const dispatching = !NO_DISPATCH_STATUSES.has(status);
  const eventText = dispatching
    ? '✓ consent received — dispatching'
    : `✓ ${status} — no action to dispatch`;

  try {
    // 1. deterministic first narration row — written here, not by the worker,
    // so the strip never shows silence while a worker spins up.
    const evResp = await fetch(`${SUPABASE_URL}/rest/v1/pulse_run_events`, {
      method: 'POST',
      headers: restHeaders,
      body: JSON.stringify({
        card_id,
        run_id: run_id || null,
        kind: 'start',
        text: eventText,
      }),
    });
    if (!evResp.ok) {
      const errText = await evResp.text();
      return { statusCode: evResp.status, body: JSON.stringify({ error: errText, stage: 'pulse_run_events' }) };
    }

    if (!dispatching) {
      return { statusCode: 200, body: JSON.stringify({ status: 'narrated-only', card_id, card_status: status }) };
    }

    // 2. the actual dispatch trigger — bridge's 2s poll picks this up.
    const cmdResp = await fetch(`${SUPABASE_URL}/rest/v1/mac_commands`, {
      method: 'POST',
      headers: restHeaders,
      body: JSON.stringify({
        command: 'act_on_answer',
        payload: { card_id, status },
        status: 'open',
      }),
    });
    if (!cmdResp.ok) {
      const errText = await cmdResp.text();
      return { statusCode: cmdResp.status, body: JSON.stringify({ error: errText, stage: 'mac_commands' }) };
    }
    const rows = await cmdResp.json();
    return { statusCode: 200, body: JSON.stringify({ status: 'queued', mac_command_id: rows[0]?.id }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
