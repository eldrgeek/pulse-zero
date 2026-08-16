// escalation-status.js — the honest half of the delegate-upwards path.
//
// The rule this exists to enforce: DO NOT FAKE A PENDING STATE THAT NOTHING
// WILL EVER RESOLVE. Every state this returns is read from a real row —
// mac_commands for the filing leg, pulse_cards + pulse_card_comments for the
// human leg. If the Mac bridge is down, or pulse-push refused the card, the
// reader is told that, in words, instead of watching a spinner forever.
//
// AUTH. Called from the browser, so it holds no secret. The caller presents
// { key, t } where t = HMAC-SHA256(PULSE_TOOL_SECRET, "escalation:<key>")
// truncated to 32 hex — minted by escalate-question.js and handed to the page
// with the escalation receipt. The key alone is derived from the question text
// and is therefore guessable; the token is not. Wrong/absent token -> 401 and
// nothing else.
//
// WHAT IT DISCLOSES. Mike's answer, resolve note, bounce reason, and his
// comments on the card, verbatim. That is deliberate — this is the return leg
// of a question a human asked. It is also why the card that escalate_question
// files says, on the card, that what Mike writes there is shown to the asker
// verbatim (pulse-mac-bridge/bridge.py :: escalate_question).
//
// GET /.netlify/functions/escalation-status?key=mark-qa-<12hex>&t=<32hex>
// -> 200 {
//      key,
//      state: "filing" | "waiting" | "answered" | "bounced" | "failed" | "unknown",
//      headline: str,          // one sentence, safe to render as-is
//      detail: str,            // one sentence more, or ""
//      filed_at, card_id, board_url,
//      human_reply: str|null,  // Mike's words, verbatim, meant for the asker
//      replies: [{ author, body, created_at }],
//      expectation: { basis, next_scheduled_review } | null,
//      checked_at
//    }
// -> 400 missing key/t · 401 bad token · 503 not configured · 502 upstream down
const crypto = require('crypto');

const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';
const BOARD_URL = 'https://pulse-zero.netlify.app';
const KEY_RE = /^mark-qa-[0-9a-f]{12}$/;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function response(statusCode, body) {
  return { statusCode, headers: cors, body: JSON.stringify(body) };
}

function statusToken(key, secret) {
  return crypto.createHmac('sha256', secret).update(`escalation:${key}`).digest('hex').slice(0, 32);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function nextMorningPass(fromMs) {
  const d = new Date(fromMs);
  const pass = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 0, 0));
  if (pass.getTime() <= fromMs) pass.setUTCDate(pass.getUTCDate() + 1);
  return pass.toISOString();
}

const EXPECT_BASIS =
  "Mike's board gets a scheduled pass every morning at 07:00 America/Denver. "
  + 'He usually reads it sooner than that. There is no SLA and nothing here promises one.';

async function sb(path, serviceKey) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`supabase ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'GET') return response(405, { error: 'GET only' });

  const toolSecret = process.env.PULSE_TOOL_SECRET;
  const serviceKey = process.env.PULSE_ZERO_SERVICE_KEY;
  if (!toolSecret || !serviceKey) {
    return response(503, { error: 'Escalation is not configured on this site (missing PULSE_TOOL_SECRET or PULSE_ZERO_SERVICE_KEY).' });
  }

  const q = event.queryStringParameters || {};
  const key = String(q.key || '');
  const token = String(q.t || '');
  if (!key || !token) return response(400, { error: 'key and t are required' });
  if (!KEY_RE.test(key)) return response(400, { error: 'malformed key' });
  if (!timingSafeEqual(token, statusToken(key, toolSecret))) return response(401, { error: 'bad token' });

  const now = new Date().toISOString();
  const base = { key, board_url: BOARD_URL, checked_at: now, card_id: null, filed_at: null, human_reply: null, replies: [], expectation: null };

  try {
    // Filing leg. jsonb key filter; newest row wins (a re-asked question
    // re-files, and pulse-push updates the same card in place via --key).
    const cmds = await sb(
      `mac_commands?command=eq.escalate_question&payload-%3E%3Ekey=eq.${encodeURIComponent(key)}`
      + '&order=created_at.desc&limit=1',
      serviceKey,
    );
    if (!cmds.length) {
      return response(200, {
        ...base,
        state: 'unknown',
        headline: 'No escalation was ever filed for this question.',
        detail: 'Nothing is pending. Ask again to send it up.',
      });
    }
    const cmd = cmds[0];
    const filedAt = (cmd.payload && cmd.payload.filed_at) || cmd.created_at || null;
    base.filed_at = filedAt;

    if (cmd.status === 'failed') {
      const err = (cmd.result && cmd.result.error) || 'unknown error';
      return response(200, {
        ...base,
        state: 'failed',
        headline: 'This question did NOT reach Mike.',
        detail: `Filing it on his board failed: ${String(err).slice(0, 300)} — nobody is waiting on it. Say so rather than expecting a reply.`,
      });
    }

    if (cmd.status === 'open') {
      // The bridge polls every 2 seconds. Still 'open' after a few minutes
      // means the Mac-side worker is not running, and the reader deserves to
      // know that instead of waiting on a queue nobody drains.
      const ageSec = filedAt ? (Date.now() - Date.parse(filedAt)) / 1000 : 0;
      const stalled = ageSec > 180;
      return response(200, {
        ...base,
        state: stalled ? 'failed' : 'filing',
        headline: stalled
          ? 'This question has NOT reached Mike yet.'
          : 'Sending this to Mike now.',
        detail: stalled
          ? `It has been queued for ${Math.round(ageSec / 60)} minutes without being picked up — the worker that puts it on his board is not running. It is not lost, but nobody has seen it yet.`
          : 'It is queued for his board; this normally takes a couple of seconds.',
      });
    }

    const cardId = (cmd.result && cmd.result.card_id) || null;
    if (!cardId) {
      return response(200, {
        ...base,
        state: 'failed',
        headline: 'This question did NOT reach Mike.',
        detail: 'The filing step reported success but returned no card. Nobody is waiting on it.',
      });
    }
    base.card_id = cardId;

    // Human leg.
    const cards = await sb(`pulse_cards?id=eq.${encodeURIComponent(cardId)}&limit=1`, serviceKey);
    if (!cards.length) {
      return response(200, {
        ...base,
        state: 'failed',
        headline: 'The card for this question is gone from the board.',
        detail: 'It was filed, but the row no longer exists. Treat it as unasked.',
      });
    }
    const card = cards[0];
    const comments = await sb(
      `pulse_card_comments?card_id=eq.${encodeURIComponent(cardId)}&order=created_at.asc&limit=50`,
      serviceKey,
    );
    base.replies = comments.map((c) => ({ author: c.author, body: c.body, created_at: c.created_at }));
    const mikeReplies = base.replies.filter((c) => c.author === 'mike');

    if (card.status === 'bounced') {
      return response(200, {
        ...base,
        state: 'bounced',
        human_reply: card.bounce_reason || null,
        headline: 'Mike sent this back rather than answering it.',
        detail: card.bounce_reason ? `He said: ${card.bounce_reason}` : '',
      });
    }
    if (card.status === 'answered' || card.status === 'resolved') {
      const reply = card.answer || card.resolved_note || (mikeReplies.length ? mikeReplies[mikeReplies.length - 1].body : null);
      return response(200, {
        ...base,
        state: 'answered',
        human_reply: reply,
        headline: 'Mike answered this himself.',
        detail: reply ? '' : 'He closed the card without writing anything back.',
      });
    }
    if (card.status !== 'open') {
      return response(200, {
        ...base,
        state: 'bounced',
        headline: `Mike closed this without answering (status: ${card.status}).`,
        detail: 'Nothing further is pending on it.',
      });
    }

    // Open. If he has commented, that is a real partial answer — show it.
    if (mikeReplies.length) {
      return response(200, {
        ...base,
        state: 'answered',
        human_reply: mikeReplies[mikeReplies.length - 1].body,
        headline: 'Mike replied on the board.',
        detail: 'He has not closed the question yet, so more may follow.',
      });
    }
    return response(200, {
      ...base,
      state: 'waiting',
      expectation: { basis: EXPECT_BASIS, next_scheduled_review: nextMorningPass(Date.parse(filedAt || now)) },
      headline: 'This one went to Mike. It is on his board, unanswered.',
      detail: 'No AI is going to answer it for him.',
    });
  } catch (e) {
    return response(502, { error: `could not read escalation state: ${e.message}` });
  }
};
