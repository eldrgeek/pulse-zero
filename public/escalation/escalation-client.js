// escalation-client.js — the browser half of the delegate-upwards path.
//
// Zero dependencies, no imports, safe to copy into another repo verbatim if a
// CSP forbids the cross-origin script. Contract: ../../ESCALATION-INTERFACE.md
//
// It does one job: turn an escalation receipt into the truth about what
// happened to a question, repeatedly, until there is nothing left to wait for.
// It deliberately has no "pending" state of its own — every state it reports
// came back from a row that exists. If the network is down it says the network
// is down; it does not keep spinning as if the question were in flight.

const TERMINAL = new Set(['answered', 'bounced', 'failed', 'unknown']);
const FILING_INTERVAL_MS = 5000;   // the bridge picks up in ~2-3s
const WAITING_INTERVAL_MS = 60000; // a human is reading it; don't hammer

/**
 * One status read.
 * @param {{key:string,status_token:string,status_url:string}} receipt
 * @returns {Promise<object>} the status object, or a synthetic
 *          {state:'unreachable'} — never a throw, because the caller's job is
 *          to render honestly and it cannot do that from an exception.
 */
export async function readEscalation(receipt) {
  const url = `${receipt.status_url}?key=${encodeURIComponent(receipt.key)}`
    + `&t=${encodeURIComponent(receipt.status_token)}`;
  let resp;
  try {
    resp = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    return {
      key: receipt.key,
      state: 'unreachable',
      headline: 'Cannot reach the board to check on this.',
      detail: 'The question may or may not have got through. This will retry.',
      transient: true,
    };
  }
  let body;
  try {
    body = await resp.json();
  } catch (_) {
    body = {};
  }
  if (!resp.ok) {
    return {
      key: receipt.key,
      state: 'unreachable',
      headline: 'Cannot read the state of this question right now.',
      detail: body.error || `The board returned ${resp.status}.`,
      transient: resp.status >= 500,
    };
  }
  return body;
}

/**
 * Poll until terminal. Calls onState with every reading, including the first.
 * @returns {() => void} stop
 */
export function pollEscalation(receipt, onState) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    const s = await readEscalation(receipt);
    if (stopped) return;
    try { onState(s); } catch (e) { /* the caller's renderer is not our problem */ }
    if (TERMINAL.has(s.state)) return;
    const delay = s.state === 'waiting' ? WAITING_INTERVAL_MS : FILING_INTERVAL_MS;
    timer = setTimeout(tick, delay);
  };

  tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/**
 * The line to show the reader. Rendering copy lives here so the page and any
 * future surface say the same true thing, and so 'failed' can never be quietly
 * styled as 'still working on it'.
 *
 * @returns {{tone:'working'|'human'|'done'|'broken', text:string, sub:string,
 *            reply:string|null}}
 */
export function escalationLine(s) {
  switch (s.state) {
    case 'filing':
      return { tone: 'working', text: s.headline, sub: s.detail, reply: null };
    case 'waiting': {
      const when = s.expectation && s.expectation.next_scheduled_review
        ? new Date(s.expectation.next_scheduled_review)
        : null;
      const sub = when
        ? `He reads the board through the day; the next scheduled pass is ${when.toLocaleString()}. `
          + 'No SLA — that is the floor, not a promise.'
        : s.detail;
      return { tone: 'human', text: s.headline, sub, reply: null };
    }
    case 'answered':
      return {
        tone: 'done',
        text: s.human_reply ? 'Mike answered this himself:' : s.headline,
        sub: s.detail,
        reply: s.human_reply || null,
      };
    case 'bounced':
      return { tone: 'done', text: s.headline, sub: s.detail, reply: s.human_reply || null };
    case 'failed':
    case 'unknown':
      return { tone: 'broken', text: s.headline, sub: s.detail, reply: null };
    default: // 'unreachable' and anything a future server adds
      return { tone: 'broken', text: s.headline || 'Unknown escalation state.', sub: s.detail || '', reply: null };
  }
}
