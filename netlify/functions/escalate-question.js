// escalate-question.js — the delegate-upwards path.
//
// WHAT THIS IS FOR. A reader-facing AI (today: the Common Ground conclusions
// surface built for Mark Inarai) answers from a fixed context corpus. When it
// CANNOT answer — the corpus does not contain it, or the question is a
// judgement only a human can make — it must not guess. It calls this endpoint,
// and the question goes to Mike on his existing Pulse Zero board.
//
// WHY IT LIVES ON pulse-zero AND NOT ON THE READER SITE. The escalation target
// IS this board. PULSE_ZERO_SERVICE_KEY and PULSE_TOOL_SECRET are already
// provisioned here in the production context, the mac_commands table is
// already this site's write surface (see mac-command.js and
// card-comment-webhook.js), and hosting it here means any future reader
// surface can escalate without a second copy of the credential. Tradeoff
// named: the reader site calls this cross-origin with a shared secret, instead
// of us copying a service_role key onto a second Netlify project.
//
// WHY IT DOES NOT WRITE pulse_cards DIRECTLY. A raw POST to /rest/v1/pulse_cards
// bypasses pulse_card_contract.validate_payload() entirely — README "Board
// standard" names raw REST as literally the only way around the contract, and
// _estate/bin/pulse-board-truth exists to audit for exactly that gap. So this
// function does what card-comment-webhook.js does: it files a mac_commands row
// and the Mac bridge (pulse-mac-bridge/bridge.py, POLL_INTERVAL=2s) shells out
// to bin/pulse-push, which is the single enforcement point. Cost of that
// choice, stated plainly: escalation depends on the Mac being up. The status
// endpoint reports that honestly rather than showing a fake pending spinner.
//
// ── INTERFACE (for the answerer component) ──────────────────────────────────
// POST https://pulse-zero.netlify.app/.netlify/functions/escalate-question
//   headers: content-type: application/json
//            x-pulse-secret: <PULSE_TOOL_SECRET>      (server-to-server only)
//   body: {
//     question:      str   REQUIRED  what the reader actually asked, verbatim
//     unresolved:    str   REQUIRED  what the AI could not resolve, and why
//     question_url:  str   REQUIRED  https deep link to this question on the
//                                    reader page — the card contract HARD
//                                    REFUSES an action card with no link
//                                    surface (no_link_surface), so there is no
//                                    silent-fallback path here
//     topic:         str   optional  <=40 char gist for the card title
//     asker:         str   optional  default "Mark"
//     tried:         str   optional  what the AI checked before giving up
//   }
// -> 200 {
//     ok: true, key, state: "filing", filed_at, mac_command_id,
//     status_token, status_url,        // hand BOTH to the browser
//     expectation: { basis, next_scheduled_review }
//   }
// -> 400 bad shape (message names the missing field)
// -> 401 bad/absent secret
// -> 503 PULSE_ZERO_SERVICE_KEY or PULSE_TOOL_SECRET absent — fails LOUD,
//        never silently drops the question
//
// The browser then polls escalation-status.js with { key, t: status_token }.
// Full contract + copy-paste client: ESCALATION-INTERFACE.md in this folder.
const crypto = require('crypto');

const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';
const SITE_URL = 'https://pulse-zero.netlify.app';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Pulse-Secret',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function response(statusCode, body) {
  return { statusCode, headers: cors, body: JSON.stringify(body) };
}

// Stable per-QUESTION, not per-topic. pulse-push's --key dedup matches OPEN
// cards only, so a per-topic-forever key would either duplicate after Mike
// answers or silently overwrite a question he is mid-answer on. Normalising
// case/whitespace/trailing punctuation means "Why did you drop it?" and
// "why did you drop it" update one card instead of minting two.
function deriveKey(question) {
  const norm = String(question)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.?!,;:]+$/g, '')
    .trim();
  return 'mark-qa-' + crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12);
}

// Unforgeable read capability for the browser. The escalation key is derived
// from the question text and is therefore guessable by anyone who knows the
// question; the token is not. This is what lets the reader page poll status
// directly without ever holding PULSE_TOOL_SECRET.
function statusToken(key, secret) {
  return crypto.createHmac('sha256', secret).update(`escalation:${key}`).digest('hex').slice(0, 32);
}

// Factual, not invented. com.mikewolf.pulse-morning is a launchd job with
// StartCalendarInterval Hour=7, Minute=0, local time — verified 2026-08-16.
// That is the only scheduled, guaranteed pass over the board, so it is the
// only honest floor we can quote. Anything tighter would be a promise nothing
// enforces.
function nextMorningPass(fromMs) {
  // America/Denver: MDT (UTC-6) mid-August. 07:00 local == 13:00 UTC.
  const d = new Date(fromMs);
  const pass = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 0, 0));
  if (pass.getTime() <= fromMs) pass.setUTCDate(pass.getUTCDate() + 1);
  return pass.toISOString();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'POST only' });
  }

  const toolSecret = process.env.PULSE_TOOL_SECRET;
  const serviceKey = process.env.PULSE_ZERO_SERVICE_KEY;
  // Fail loud, never degrade to "looks fine". A silently-dropped escalation is
  // strictly worse than an error the reader can see, because the reader would
  // sit waiting for a human who was never told.
  if (!toolSecret) {
    return response(503, { error: 'Escalation is not configured: PULSE_TOOL_SECRET is not set on this site.' });
  }
  if (!serviceKey) {
    return response(503, { error: 'Escalation is not configured: PULSE_ZERO_SERVICE_KEY is not set on this site.' });
  }

  const got = event.headers['x-pulse-secret'] || event.headers['X-Pulse-Secret'];
  if (got !== toolSecret) {
    return response(401, { error: 'bad secret' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return response(400, { error: 'invalid JSON' });
  }

  const question = String(body.question || '').trim();
  const unresolved = String(body.unresolved || '').trim();
  const questionUrl = String(body.question_url || '').trim();
  if (!question) return response(400, { error: 'question is required (the reader\'s question, verbatim)' });
  if (!unresolved) return response(400, { error: 'unresolved is required (what the AI could not resolve, and why)' });
  if (!questionUrl) {
    return response(400, {
      error: 'question_url is required — the card contract hard-refuses an action card with no link surface (no_link_surface)',
    });
  }
  if (!/^https:\/\//i.test(questionUrl)) {
    return response(400, { error: 'question_url must be an absolute https URL' });
  }

  const key = deriveKey(question);
  const filedAt = new Date().toISOString();

  const payload = {
    key,
    question,
    unresolved,
    question_url: questionUrl,
    topic: String(body.topic || '').trim().slice(0, 80),
    asker: String(body.asker || 'Mark').trim().slice(0, 40),
    tried: String(body.tried || '').trim().slice(0, 2000),
    filed_at: filedAt,
  };

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/mac_commands`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ command: 'escalate_question', payload, status: 'open' }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return response(resp.status, { error: `could not queue escalation: ${errText.slice(0, 300)}` });
    }
    const rows = await resp.json();
    return response(200, {
      ok: true,
      key,
      state: 'filing',
      filed_at: filedAt,
      mac_command_id: rows[0]?.id ?? null,
      status_token: statusToken(key, toolSecret),
      status_url: `${SITE_URL}/.netlify/functions/escalation-status`,
      expectation: {
        basis:
          "Mike's board gets a scheduled pass every morning at 07:00 America/Denver. "
          + 'He usually reads it sooner than that. There is no SLA and nothing here promises one.',
        next_scheduled_review: nextMorningPass(Date.parse(filedAt)),
      },
    });
  } catch (e) {
    return response(502, { error: `could not reach the board: ${e.message}` });
  }
};
