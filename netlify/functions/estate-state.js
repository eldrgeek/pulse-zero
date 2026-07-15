// estate-state.js — read-only "what's going on" snapshot for the Pulse talk agent.
// GET only. Merges a build-time changelog snapshot (state-snapshot.json, regenerated
// from ~/Projects/ESTATE.md by bin/gen-state-snapshot.py) with a live pulse_cards query.
const snapshot = require('./state-snapshot.json');

const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';
const APP_ID = 'pulse-zero';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Pulse-Secret',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS' }, body: '' };
  }

  const expected = process.env.PULSE_TOOL_SECRET;
  const got = event.headers['x-pulse-secret'] || event.headers['X-Pulse-Secret'];
  if (expected && got !== expected) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'bad secret' }) };
  }

  const serviceKey = process.env.PULSE_ZERO_SERVICE_KEY;
  let openCards = [];
  let cardError = null;
  if (serviceKey) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/pulse_cards?app_id=eq.${APP_ID}&status=eq.open&select=type,payload,created_at&order=created_at.desc&limit=25`;
      const resp = await fetch(url, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (resp.ok) {
        const rows = await resp.json();
        openCards = rows.map((r) => ({
          type: r.type,
          title: r.payload?.title || r.payload?.artifact_name || r.payload?.question || '(untitled)',
          created_at: r.created_at,
        }));
      } else {
        cardError = `pulse_cards query failed: ${resp.status}`;
      }
    } catch (e) {
      cardError = e.message;
    }
  } else {
    cardError = 'PULSE_ZERO_SERVICE_KEY not set';
  }

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({
      open_cards: openCards,
      open_card_count: openCards.length,
      changelog: snapshot.changelog,
      live_urls: snapshot.live_urls,
      card_error: cardError,
    }),
  };
};
