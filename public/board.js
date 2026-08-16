// board.js — Pulse One v2: keyed per-card reconciliation + the run-state card.
//
// WQ-301 slice 2 (frictionless-console-v1.md §"Context mechanics" + the
// run-state-card paragraph). Parallel render path behind `?v2=1` — the
// legacy renderer in index.html (loadLegacyCards/loadCards/renderCard's
// default onDone=loadCards path) is untouched by this file.
//
// Plain classic script, loaded after index.html's own inline <script> (see
// the comment at that <script src="/board.js"> tag) so it shares the same
// global scope: sb, APP_ID, esc, renderCard, cardTitleText, cardKindLabel,
// isSnoozedActive, etc. are all already defined by the time this file runs.
// No import/export, no bundler — matches this repo's zero-build convention
// (same pattern pulse-actions.js already uses for PulseActions).
//
// The core idea: every card is a keyed DOM node (store: Map<cardId, entry>).
// A realtime patch replaces ONLY that one card's node (patchCard) — never
// `main.innerHTML = ''`, never a plain loadCards() re-render. Cards that
// dispatch work (answered/resolved, not yet a terminal pulse_run_events row)
// render as a minimal "run chip" that stays in place until a receipt/error
// event folds it into a one-line done ribbon — Mike's verbatim ask
// (2026-08-16 evening): "when a build is dispatched, instead of the card
// disappearing it turns into something minimal that says that the build is
// running and a way to get details."

// Top-level declarations, no IIFE — same convention as index.html's own
// inline script (a plain classic script; board.js loads after it and
// shares its global scope). This also keeps board.js directly testable the
// same way test/pulse-drill-accordion.test.js exercises index.html: read
// the file, eval it with `new Function(...)`, return the functions under
// test.
const store = new Map(); // cardId -> { data, runEvents, node, optimistic, drillOpen }
let cardOrder = [];
let newTray = [];
const pendingNewData = new Map();
let initialLoadDone = false;
let channelV2 = null;
let reconnectTimer = null;
let staleSinceReconnectNeeded = false;
let realtimeQueue = [];
let debounceTimer = null;
let processingQueue = false;
let tickTimer = null;

  // ── data fetch (mirrors loadLegacyCards' two-query split so an open card
  // is never hidden behind a status-sorted LIMIT once history grows) ──────
  async function fetchBoardDataV2() {
    const [activeResult, historyResult] = await Promise.all([
      sb.from('pulse_cards')
        .select('*, pulse_card_comments(*)')
        .eq('app_id', APP_ID)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(100),
      sb.from('pulse_cards')
        .select('*, pulse_card_comments(*)')
        .eq('app_id', APP_ID)
        .neq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(45),
    ]);
    const error = activeResult.error || historyResult.error;
    const cards = [...(activeResult.data || []), ...(historyResult.data || [])];
    if (error || !cards.length) return { cards, events: [], error };
    const ids = cards.map(c => c.id);
    const evResult = await sb.from('pulse_run_events')
      .select('*')
      .in('card_id', ids)
      .order('ts', { ascending: true })
      .limit(2000);
    return { cards, events: evResult.data || [], error };
  }

  function groupBy(arr, key) {
    const out = {};
    (arr || []).forEach(x => { (out[x[key]] = out[x[key]] || []).push(x); });
    return out;
  }

  // ── run-state mechanics ─────────────────────────────────────────────────
  function cardMode(entry) {
    const c = entry.data;
    if (c.status === 'open') return entry.optimistic ? 'answering' : 'open';
    // retired/bounced: no worker dispatched (card-answer-webhook.js's
    // NO_DISPATCH_STATUSES) — narrated-only, terminal from the first event.
    if (c.status === 'retired' || c.status === 'bounced') return 'done';
    // answered/resolved: a run was dispatched. Stays a live chip until a
    // receipt or error event lands.
    const events = entry.runEvents || [];
    const terminal = events.some(e => e.kind === 'receipt' || e.kind === 'error');
    return terminal ? 'done' : 'run';
  }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h) return `${h}h${m % 60}m`;
    if (m) return `${m}m${String(s % 60).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function linkify(text) {
    return esc(text || '').replace(/(https?:\/\/[^\s]+)/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  }

  function renderRunTimeline(events) {
    if (!events || !events.length) return '<p class="muted">No run events yet.</p>';
    return '<ul class="v2-run-timeline">' + events.map(e =>
      `<li><span class="v2-run-kind v2-run-kind-${esc(e.kind)}">${esc(e.kind)}</span>` +
      `<span class="v2-run-ts">${esc(new Date(e.ts).toLocaleTimeString())}</span> — ${linkify(e.text)}</li>`
    ).join('') + '</ul>';
  }

  // A run with no event for >5 minutes reads as stalled — never silence,
  // per the spec's explicit rule ("If no event arrives for 5 minutes the
  // strip says 'stalled — sweeper retrying,' never silence").
  const STALL_MS = 5 * 60 * 1000;

  function renderRunChip(entry) {
    const c = entry.data;
    const events = (entry.runEvents || []).slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const last = events[events.length - 1];
    const startTs = events[0] ? new Date(events[0].ts) : new Date(c.answered_at || c.created_at);
    const elapsedMs = Date.now() - startTs.getTime();
    const sinceLastMs = last ? Date.now() - new Date(last.ts).getTime() : elapsedMs;
    const isStalled = sinceLastMs > STALL_MS;
    const statusLine = isStalled
      ? '⚠ stalled — sweeper will retry'
      : `● running — ${fmtElapsed(elapsedMs)} — ${esc(last ? last.text : 'dispatching…')}`;
    const div = document.createElement('div');
    div.className = 'v2-run-chip';
    div.dataset.cardId = c.id;
    div.innerHTML = `
      <span class="kind kind-${esc(c.type)}">${esc(cardKindLabel(c.type))}</span>
      <p class="title">${esc(cardTitleText(c))}</p>
      <p class="run-status-line">${statusLine}</p>
      <button class="v2-drill-toggle" data-action="drill" aria-expanded="${entry.drillOpen ? 'true' : 'false'}">${entry.drillOpen ? 'Hide details' : 'Details'}</button>
      <div class="v2-run-drill" style="display:${entry.drillOpen ? 'block' : 'none'}">${renderRunTimeline(events)}</div>`;
    div.querySelector('[data-action="drill"]').onclick = () => {
      entry.drillOpen = !entry.drillOpen;
      patchCard(c.id);
    };
    return div;
  }

  function renderDoneRibbon(entry) {
    const c = entry.data;
    const events = (entry.runEvents || []).slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const last = events[events.length - 1];
    const ok = !events.some(e => e.kind === 'error');
    const label = last ? last.text : (c.status === 'retired' ? 'retired' : c.status === 'bounced' ? 'bounced' : c.status);
    const div = document.createElement('div');
    div.className = 'v2-done-ribbon' + (ok ? '' : ' v2-done-error');
    div.dataset.cardId = c.id;
    div.innerHTML = `
      <span class="kind kind-${esc(c.type)}">${esc(cardKindLabel(c.type))}</span>
      <button class="v2-done-line" data-action="drill" aria-expanded="${entry.drillOpen ? 'true' : 'false'}">${ok ? '✅' : '❌'} ${esc(cardTitleText(c))} — ${esc(label)}</button>
      <div class="v2-run-drill" style="display:${entry.drillOpen ? 'block' : 'none'}">${renderRunTimeline(events)}</div>`;
    div.querySelector('[data-action="drill"]').onclick = () => {
      entry.drillOpen = !entry.drillOpen;
      patchCard(c.id);
    };
    return div;
  }

  // ── open-card path: reuse renderCard() verbatim for markup/behavior, but
  // (a) pass a no-op onDone — v2 never re-renders from a write's own
  // success callback, only from the realtime row it produces, so a slow or
  // dropped realtime event can't leave the UI stuck mid-optimism forever
  // without also breaking the invariant that only realtime drives content;
  // and (b) intercept answer clicks to flip an optimistic "sent" strip in
  // place before the network round trip completes, per spec: 'optimistic
  // "✓ sent" before that [dispatcher event] arrives'. ──────────────────────
  const ANSWERING_ACTIONS = new Set(['done', 'opt', 'accept', 'retire', 'ack']);

  function wireOptimisticIntercept(node, entry) {
    node.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || !ANSWERING_ACTIONS.has(btn.dataset.action)) return;
      entry.optimistic = true;
      // Defer past this click's own bubble-phase handler (renderCard's
      // answerCard call), which is still running against `node` — replacing
      // it synchronously here would pull the rug out from under its own
      // in-flight await.
      setTimeout(() => patchCard(entry.data.id), 0);
    }, true);
  }

  function renderAnsweringNode(entry) {
    const node = renderCard(entry.data, () => {});
    const actionsEl = node.querySelector('.actions');
    if (actionsEl) actionsEl.outerHTML = '<p class="run-status-line">✓ sent — dispatching…</p>';
    return node;
  }

  function buildNode(entry) {
    const mode = cardMode(entry);
    let node;
    if (mode === 'answering') {
      node = renderAnsweringNode(entry);
    } else if (mode === 'open') {
      node = renderCard(entry.data, () => {});
      wireOptimisticIntercept(node, entry);
    } else if (mode === 'run') {
      node = renderRunChip(entry);
    } else {
      node = renderDoneRibbon(entry);
    }
    node.dataset.cardId = entry.data.id;
    return node;
  }

  function patchCard(id) {
    const entry = store.get(id);
    if (!entry || !entry.node || !entry.node.isConnected) return;
    const newNode = buildNode(entry);
    entry.node.replaceWith(newNode);
    entry.node = newNode;
  }

  function countOpen() {
    let n = 0;
    store.forEach(entry => { if (entry.data.status === 'open' && !isSnoozedActive(entry.data)) n++; });
    return n;
  }

  function updateCount() {
    const el = document.getElementById('v2-count');
    if (el) el.textContent = countOpen() + ' open';
  }

  // ── New tray — a realtime INSERT after the initial load never displaces
  // what's on screen; it lands in a count chip Mike opens on his own terms.
  function renderNewTrayChip() {
    const tray = document.getElementById('v2-new-tray');
    if (!tray) return;
    if (!newTray.length) { tray.style.display = 'none'; tray.innerHTML = ''; return; }
    tray.style.display = 'block';
    tray.innerHTML = `<button id="v2-new-tray-btn">${newTray.length} new — show</button>`;
    document.getElementById('v2-new-tray-btn').onclick = revealNewTrayV2;
  }

  function revealNewTrayV2() {
    const main = document.getElementById('v2-cards');
    const emptyMsg = main.querySelector('.empty');
    if (emptyMsg) emptyMsg.remove();
    newTray.forEach(id => {
      const data = pendingNewData.get(id);
      if (!data || store.has(id)) return;
      const entry = { data, runEvents: [], node: null, optimistic: false, drillOpen: false };
      store.set(id, entry);
      const node = buildNode(entry);
      entry.node = node;
      main.appendChild(node);
      cardOrder.push(id);
      pendingNewData.delete(id);
    });
    newTray = [];
    renderNewTrayChip();
    updateCount();
  }

  // ── realtime ─────────────────────────────────────────────────────────
  function enqueueRealtimeEvent(evt) {
    realtimeQueue.push(evt);
    if (debounceTimer) return;
    debounceTimer = setTimeout(drainRealtimeQueueV2, 150);
  }

  async function drainRealtimeQueueV2() {
    debounceTimer = null;
    if (processingQueue) { debounceTimer = setTimeout(drainRealtimeQueueV2, 150); return; }
    processingQueue = true;
    const batch = realtimeQueue.splice(0, realtimeQueue.length);
    try {
      for (const evt of batch) await handleRealtimeEventV2(evt);
    } finally {
      processingQueue = false;
    }
  }

  async function handleRealtimeEventV2({ source, payload }) {
    if (source === 'pulse_cards') return handleCardChangeV2(payload);
    if (source === 'pulse_card_comments') return handleCommentChangeV2(payload);
    if (source === 'pulse_run_events') return handleRunEventV2(payload);
  }

  function handleCardChangeV2(payload) {
    const row = (payload.new && Object.keys(payload.new).length) ? payload.new : payload.old;
    if (!row || !row.id) return;
    const id = row.id;
    if (payload.eventType === 'DELETE') {
      const entry = store.get(id);
      if (entry) { entry.node.remove(); store.delete(id); cardOrder = cardOrder.filter(x => x !== id); }
      newTray = newTray.filter(x => x !== id);
      pendingNewData.delete(id);
      renderNewTrayChip();
      updateCount();
      return;
    }
    const entry = store.get(id);
    if (entry) {
      // Realtime card payloads don't carry the embedded comments FK join —
      // keep whatever we already loaded until a comment-table event refreshes it.
      entry.data = { ...entry.data, ...payload.new, pulse_card_comments: entry.data.pulse_card_comments };
      entry.optimistic = false;
      patchCard(id);
      updateCount();
      return;
    }
    if (payload.eventType === 'INSERT' && initialLoadDone) {
      pendingNewData.set(id, payload.new);
      if (!newTray.includes(id)) newTray.push(id);
      renderNewTrayChip();
    }
  }

  async function handleCommentChangeV2(payload) {
    const row = (payload.new && Object.keys(payload.new).length) ? payload.new : payload.old;
    const cardId = row && row.card_id;
    if (!cardId || !store.has(cardId)) return;
    const { data, error } = await sb.from('pulse_cards').select('pulse_card_comments(*)').eq('id', cardId).single();
    if (error) return;
    const entry = store.get(cardId);
    if (!entry) return;
    entry.data.pulse_card_comments = (data && data.pulse_card_comments) || [];
    patchCard(cardId);
  }

  function handleRunEventV2(payload) {
    const row = payload.new;
    if (!row || !row.card_id || !store.has(row.card_id)) return;
    const entry = store.get(row.card_id);
    entry.runEvents = [...(entry.runEvents || []), row];
    patchCard(row.card_id);
  }

  function setStaleV2(isStale) {
    const el = document.getElementById('v2-stale-badge');
    if (el) el.style.display = isStale ? 'inline' : 'none';
  }

  function subscribeRealtimeV2() {
    if (channelV2) return;
    channelV2 = sb.channel('pulse_zero_v2_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pulse_cards', filter: `app_id=eq.${APP_ID}` },
        (payload) => enqueueRealtimeEvent({ source: 'pulse_cards', payload }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pulse_card_comments' },
        (payload) => enqueueRealtimeEvent({ source: 'pulse_card_comments', payload }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pulse_run_events' },
        (payload) => enqueueRealtimeEvent({ source: 'pulse_run_events', payload }))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setStaleV2(false);
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          if (staleSinceReconnectNeeded) {
            staleSinceReconnectNeeded = false;
            refetchAndReconcileV2();
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setStaleV2(true);
          staleSinceReconnectNeeded = true;
          scheduleReconnectV2();
        }
      });
  }

  function scheduleReconnectV2() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (channelV2) { sb.removeChannel(channelV2); channelV2 = null; }
      subscribeRealtimeV2();
    }, 5000);
  }

  function stopCardsRealtimeV2() {
    if (channelV2) { sb.removeChannel(channelV2); channelV2 = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    document.removeEventListener('visibilitychange', onVisibilityChangeV2);
    store.clear();
    cardOrder = [];
    newTray = [];
    pendingNewData.clear();
    initialLoadDone = false;
}

  // Reconnect / return-to-tab both re-sync against the DB rather than trust
  // that nothing happened while the socket (or the tab) was away — a board
  // that goes stale silently was audit-ui.md violation #10.
  async function onVisibilityChangeV2() {
    if (document.visibilityState === 'visible') await refetchAndReconcileV2();
  }

  async function refetchAndReconcileV2() {
    const { cards, events, error } = await fetchBoardDataV2();
    if (error) return;
    await loadTypedActionRuns(cards);
    const eventsByCard = groupBy(events, 'card_id');
    cards.forEach(c => {
      const entry = store.get(c.id);
      if (entry) {
        entry.data = { ...c };
        entry.runEvents = eventsByCard[c.id] || [];
        entry.optimistic = false;
        patchCard(c.id);
      } else if (!newTray.includes(c.id) && !pendingNewData.has(c.id)) {
        pendingNewData.set(c.id, c);
        newTray.push(c.id);
      }
    });
    renderNewTrayChip();
    updateCount();
  }

  function tickRunChips() {
    store.forEach((entry, id) => { if (cardMode(entry) === 'run') patchCard(id); });
  }

  function applyCardDeepLinkV2() {
    const id = new URLSearchParams(location.search).get('card');
    if (!id) return;
    const el = document.querySelector(`#v2-cards [data-card-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prevOutline = el.style.outline;
    el.style.outline = '2px solid #6ea8fe';
    el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = prevOutline; el.style.outlineOffset = ''; }, 3000);
  }

  // ── boot ─────────────────────────────────────────────────────────────
  async function renderAppV2(session) {
    app.innerHTML = `
      <header>
        <h1>Pulse Zero <span class="v2-badge">v2</span></h1>
        <span class="count" id="v2-count"></span>
        <span id="v2-stale-badge" class="v2-stale" style="display:none">⚠ reconnecting…</span>
      </header>
      <div id="v2-new-tray" class="v2-new-tray" style="display:none"></div>
      <main id="v2-cards"><div class="empty">Loading...</div></main>`;
    const main = document.getElementById('v2-cards');
    const { cards, events, error } = await fetchBoardDataV2();
    if (error) {
      main.innerHTML = `<div class="empty">Load error: ${esc(error.message)}</div>`;
      return;
    }
    store.clear();
    cardOrder = [];
    newTray = [];
    pendingNewData.clear();
    await loadTypedActionRuns(cards);
    const eventsByCard = groupBy(events, 'card_id');

    const open = cards.filter(c => c.status === 'open' && !isSnoozedActive(c));
    // Non-open cards stay visible inline (this is the run-state acceptance
    // surface: an answered card must not vanish) unless they're both
    // terminal AND old — those collapse into a plain <details> so the board
    // doesn't turn into an endless ribbon list on day two. "Old" = no run
    // event (or answer) within the last 24h.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const recentCutoff = Date.now() - DAY_MS;
    const others = cards.filter(c => !(c.status === 'open' && !isSnoozedActive(c)));
    const recentOthers = [];
    const olderOthers = [];
    others.forEach(c => {
      const evs = eventsByCard[c.id] || [];
      const terminal = evs.some(e => e.kind === 'receipt' || e.kind === 'error');
      const lastTs = evs.length ? new Date(evs[evs.length - 1].ts).getTime() : new Date(c.answered_at || c.created_at).getTime();
      if (!terminal || lastTs >= recentCutoff) recentOthers.push(c);
      else olderOthers.push(c);
    });

    main.innerHTML = '';
    const visible = [...open, ...recentOthers];
    if (!visible.length && !olderOthers.length) {
      main.innerHTML = '<div class="empty">Nothing to manage right now.</div>';
    } else {
      if (!visible.length) main.innerHTML = '<div class="empty">Nothing open right now.</div>';
      visible.forEach(c => {
        const entry = { data: c, runEvents: eventsByCard[c.id] || [], node: null, optimistic: false, drillOpen: false };
        store.set(c.id, entry);
        const node = buildNode(entry);
        entry.node = node;
        main.appendChild(node);
        cardOrder.push(c.id);
      });
      if (olderOthers.length) {
        const details = document.createElement('details');
        details.className = 'bounced-section';
        details.innerHTML = `<summary>History — ${olderOthers.length}</summary>`;
        olderOthers.forEach(c => {
          const entry = { data: c, runEvents: eventsByCard[c.id] || [], node: null, optimistic: false, drillOpen: false };
          store.set(c.id, entry);
          const node = buildNode(entry);
          entry.node = node;
          details.appendChild(node);
          cardOrder.push(c.id);
        });
        main.appendChild(details);
      }
    }
    updateCount();
    initialLoadDone = true;
    applyCardDeepLinkV2();
    subscribeRealtimeV2();
    if (!tickTimer) tickTimer = setInterval(tickRunChips, 20000);
    document.removeEventListener('visibilitychange', onVisibilityChangeV2);
    document.addEventListener('visibilitychange', onVisibilityChangeV2);
}
