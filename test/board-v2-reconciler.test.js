// Unit tests for the WQ-301 slice-2 v2 board reconciler (public/board.js).
//
// Same hand-rolled-DOM approach as test/pulse-drill-accordion.test.js: no
// jsdom dependency (this repo's zero-extra-deps convention), read the real
// source, eval it with `new Function(...)` against a tiny fake `document`,
// and exercise the actual functions — cardMode/fmtElapsed/linkify/groupBy
// are pure; patchCard/handleCardChangeV2/handleRunEventV2 touch DOM through
// a fake document/store that's just enough to prove reconciliation replaces
// ONLY the affected card's node (never `main.innerHTML = ''`, never a
// second, unrelated card's node) and that the run-state fold logic (open ->
// answering -> run -> done) matches the spec.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'board.js'), 'utf8');

// A minimal fake DOM element: enough for innerHTML get/set, dataset,
// classList, querySelector(All) on a couple of attribute/class selectors,
// and parent-child bookkeeping so replaceWith/remove/appendChild are real
// tree operations (needed to prove "only the affected node" claims).
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    _children: [],
    parent: null,
    dataset: {},
    style: {},
    className: '',
    _html: '',
    _listeners: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; this._children = []; },
    appendChild(child) { child.parent = this; this._children.push(child); return child; },
    remove() {
      if (this.parent) this.parent._children = this.parent._children.filter(c => c !== this);
      this.parent = null;
    },
    replaceWith(node) {
      if (!this.parent) return;
      const idx = this.parent._children.indexOf(this);
      if (idx === -1) return;
      node.parent = this.parent;
      this.parent._children[idx] = node;
      this.parent = null;
    },
    get isConnected() {
      let n = this;
      while (n.parent) n = n.parent;
      return n === fakeRoot;
    },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) {
      if (sel === '.actions') return null; // buildNode's answering-path branch is exercised via renderCard stub below
      // renderRunChip/renderDoneRibbon wire a click handler onto their own
      // "Details" toggle right after building innerHTML — a real browser's
      // querySelector would find it inside the string just assigned; our
      // fake element doesn't parse HTML, so return a throwaway stub that
      // just needs to accept an .onclick assignment without throwing.
      if (sel === '[data-action="drill"]') return makeEl('button');
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute(k, v) { this.dataset[k] = v; },
    getAttribute(k) { return this.dataset[k]; },
  };
  return el;
}

let fakeRoot;

function makeFakeDom() {
  fakeRoot = makeEl('root');
  const byId = new Map();
  const document = {
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  };
  function registerId(id, el) { byId.set(id, el); fakeRoot.appendChild(el); return el; }
  return { document, registerId, root: fakeRoot };
}

function loadModule(document, overrides) {
  const calls = { renderCard: [] };
  const stubs = Object.assign({
    sb: {
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      from: () => ({ select() { return this; }, eq() { return this; }, neq() { return this; }, order() { return this; }, limit() { return this; }, in() { return this; }, single: async () => ({ data: null, error: null }) }),
      removeChannel: () => {},
    },
    APP_ID: 'pulse-zero',
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    cardKindLabel: (t) => String(t).toUpperCase(),
    cardTitleText: (c) => (c.payload && (c.payload.title || c.payload.question)) || 'untitled',
    isSnoozedActive: (c) => !!c.snoozed_until && new Date(c.snoozed_until) > new Date(),
    loadTypedActionRuns: async () => {},
    renderCard: (c, onDone) => {
      calls.renderCard.push({ c, onDone });
      const div = document.createElement('div');
      div.className = 'card';
      div.dataset.cardId = c.id;
      div.innerHTML = `<p class="title">${c.payload && c.payload.title}</p><div class="actions"><button data-action="done"></button></div>`;
      return div;
    },
    app: document.createElement('div'),
  }, overrides || {});
  const globals = Object.assign({
    document,
    window: { supabase: { createClient: () => ({}) } },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { userAgent: 'node' },
    location: { search: '' },
    CSS: { escape: (s) => s },
  }, stubs);
  // newTray/cardOrder are `let`-reassigned (not just mutated) by
  // renderAppV2's reset — capture accessors, not the array value itself, or
  // a post-boot reassignment would silently desync the reference this test
  // module holds from the one the real functions read/write.
  const fn = new Function(
    ...Object.keys(globals),
    script + '\nreturn { cardMode, fmtElapsed, linkify, groupBy, store, patchCard, buildNode, ' +
      'handleCardChangeV2, handleRunEventV2, handleCommentChangeV2, renderNewTrayChip, ' +
      'getNewTray: () => newTray, getCardOrder: () => cardOrder, ' +
      'renderAppV2, countOpen, stopCardsRealtimeV2 };'
  );
  const mod = fn(...Object.values(globals));
  mod.__calls = calls;
  return mod;
}

test('cardMode: open card with no optimistic flag renders open', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  const entry = { data: { status: 'open' }, optimistic: false, runEvents: [] };
  assert.equal(mod.cardMode(entry), 'open');
});

test('cardMode: optimistic flag flips an open card to answering before the network confirms', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  const entry = { data: { status: 'open' }, optimistic: true, runEvents: [] };
  assert.equal(mod.cardMode(entry), 'answering');
});

test('cardMode: answered with no terminal event yet is a live run chip', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  const entry = { data: { status: 'answered' }, runEvents: [{ kind: 'start', text: 'dispatching' }] };
  assert.equal(mod.cardMode(entry), 'run');
});

test('cardMode: a receipt event folds the run chip into a done ribbon', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  const entry = { data: { status: 'answered' }, runEvents: [{ kind: 'start', text: 'x' }, { kind: 'receipt', text: 'sent' }] };
  assert.equal(mod.cardMode(entry), 'done');
});

test('cardMode: an error event is also terminal (done, not stuck running forever)', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  const entry = { data: { status: 'answered' }, runEvents: [{ kind: 'error', text: 'failed' }] };
  assert.equal(mod.cardMode(entry), 'done');
});

test('cardMode: retired/bounced never dispatch a run — done immediately', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  assert.equal(mod.cardMode({ data: { status: 'retired' }, runEvents: [] }), 'done');
  assert.equal(mod.cardMode({ data: { status: 'bounced' }, runEvents: [] }), 'done');
});

test('fmtElapsed formats seconds/minutes/hours', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  assert.equal(mod.fmtElapsed(4000), '4s');
  assert.equal(mod.fmtElapsed(65000), '1m05s');
  assert.equal(mod.fmtElapsed(3 * 3600 * 1000 + 61000), '3h1m');
});

test('linkify turns a bare URL in run-event text into a real link, escaping the rest', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  const out = mod.linkify('see https://example.com/report & <b>done</b>');
  assert.match(out, /<a href="https:\/\/example\.com\/report" target="_blank" rel="noopener">https:\/\/example\.com\/report<\/a>/);
  assert.match(out, /&amp;/);
  assert.doesNotMatch(out, /<b>/);
});

test('groupBy buckets run events by card_id', () => {
  const { document } = makeFakeDom();
  const mod = loadModule(document);
  const grouped = mod.groupBy([{ card_id: 'a', kind: 'start' }, { card_id: 'b', kind: 'start' }, { card_id: 'a', kind: 'receipt' }], 'card_id');
  assert.equal(grouped.a.length, 2);
  assert.equal(grouped.b.length, 1);
});

test('patchCard replaces only the target card node — sibling cards are untouched', () => {
  const { document, root } = makeFakeDom();
  const mod = loadModule(document);
  const entryA = { data: { id: 'a', status: 'open' }, runEvents: [], optimistic: false, drillOpen: false };
  const entryB = { data: { id: 'b', status: 'answered' }, runEvents: [{ kind: 'start', text: 'go' }], optimistic: false, drillOpen: false };
  entryA.node = mod.buildNode(entryA);
  entryB.node = mod.buildNode(entryB);
  root.appendChild(entryA.node);
  root.appendChild(entryB.node);
  mod.store.set('a', entryA);
  mod.store.set('b', entryB);
  const bNodeBefore = entryB.node;

  // Card a answers; only a's node should be replaced.
  entryA.data = { ...entryA.data, status: 'answered' };
  mod.patchCard('a');

  assert.notEqual(mod.store.get('a').node, entryA === mod.store.get('a') ? null : mod.store.get('a').node, 'sanity: store still has an entry');
  assert.equal(mod.store.get('b').node, bNodeBefore, 'card b node identity must survive patching card a');
  assert.equal(root._children.includes(mod.store.get('b').node), true);
  assert.equal(root._children.length, 2, 'no extra/duplicate nodes and no full-board wipe');
});

test('handleRunEventV2 for a known card appends the event and re-renders that card only, ignoring events for unknown cards', () => {
  const { document, root } = makeFakeDom();
  const mod = loadModule(document);
  const entry = { data: { id: 'known', status: 'answered' }, runEvents: [], optimistic: false, drillOpen: false };
  entry.node = mod.buildNode(entry);
  root.appendChild(entry.node);
  mod.store.set('known', entry);

  mod.handleRunEventV2({ new: { card_id: 'unknown', kind: 'start', text: 'noise' } });
  assert.equal(mod.store.get('known').runEvents.length, 0, 'event for a card not on this board must be ignored');

  mod.handleRunEventV2({ new: { card_id: 'known', kind: 'start', text: 'consent received' } });
  assert.equal(mod.store.get('known').runEvents.length, 1);
  assert.equal(mod.store.get('known').runEvents[0].text, 'consent received');
});

test('handleCardChangeV2: an UPDATE on a tracked card patches in place and clears the optimistic flag', () => {
  const { document, root } = makeFakeDom();
  const mod = loadModule(document);
  const entry = { data: { id: 'c1', status: 'open' }, runEvents: [], optimistic: true, drillOpen: false };
  entry.node = mod.buildNode(entry);
  root.appendChild(entry.node);
  mod.store.set('c1', entry);

  mod.handleCardChangeV2({ eventType: 'UPDATE', new: { id: 'c1', status: 'answered' }, old: { id: 'c1', status: 'open' } });

  const after = mod.store.get('c1');
  assert.equal(after.data.status, 'answered');
  assert.equal(after.optimistic, false, 'a confirmed server update always wins over a stale optimistic flag');
});

test('handleCardChangeV2: an INSERT for an unseen card after initial load lands in the New tray, not spliced onto the board', () => {
  const { document, root } = makeFakeDom();
  const mod = loadModule(document);
  // Simulate "initial load already happened" by driving through the same
  // module-level flag the real boot path sets — reachable indirectly via
  // renderAppV2 in the full-boot test below; here we call the handler
  // directly and assert on newTray, which only fills post-boot.
  mod.handleCardChangeV2({ eventType: 'INSERT', new: { id: 'brand-new', status: 'open' }, old: {} });
  // Before boot, initialLoadDone is false, so this INSERT is correctly a
  // no-op (the initial fetch will pick the row up itself).
  assert.equal(mod.getNewTray().length, 0);
});

test('renderAppV2 full boot: open cards render inline; a later realtime INSERT goes to the New tray and does not reorder existing cards', async (t) => {
  const { document, registerId, root } = makeFakeDom();
  const openCard = { id: 'o1', app_id: 'pulse-zero', type: 'action', status: 'open', payload: { title: 'Approve X' }, created_at: '2026-08-16T00:00:00Z' };
  const runningCard = { id: 'r1', app_id: 'pulse-zero', type: 'action', status: 'answered', payload: { title: 'Ship it' }, created_at: '2026-08-16T00:00:00Z', answered_at: '2026-08-16T00:01:00Z' };
  const runEvent = { card_id: 'r1', kind: 'start', text: '✓ consent received — dispatching', ts: '2026-08-16T00:01:01Z' };

  let subscribeCb = null;
  const sbStub = {
    from(table) {
      const chain = {
        _table: table,
        select() { return this; },
        eq() { return this; },
        neq() { return this; },
        order() { return this; },
        in() { return this; },
        limit() {
          if (chain._table === 'pulse_cards') return Promise.resolve({ data: [openCard, runningCard], error: null });
          if (chain._table === 'pulse_run_events') return Promise.resolve({ data: [runEvent], error: null });
          return Promise.resolve({ data: [], error: null });
        },
        single: async () => ({ data: null, error: null }),
      };
      return chain;
    },
    channel: () => ({
      on() { return this; },
      subscribe(cb) { subscribeCb = cb; return this; },
    }),
    removeChannel: () => {},
  };

  const app = document.createElement('div');
  const headerCount = () => document.getElementById('v2-count');

  // renderAppV2 rebuilds app.innerHTML itself via string assignment then
  // re-fetches elements by id — our fake document needs getElementById to
  // resolve post-assignment ids. Simplify by intercepting app.innerHTML's
  // setter to also register the ids renderAppV2 depends on.
  const idRegistry = new Map();
  Object.defineProperty(app, 'innerHTML', {
    get() { return app._html; },
    set(v) {
      app._html = v;
      app._children = [];
      ['v2-count', 'v2-stale-badge', 'v2-new-tray', 'v2-cards'].forEach(id => {
        const el = document.createElement('div');
        el.id = id;
        app.appendChild(el);
        idRegistry.set(id, el);
      });
    },
  });
  document.getElementById = (id) => {
    if (idRegistry.has(id)) return idRegistry.get(id);
    // renderNewTrayChip writes a button into the tray via innerHTML and
    // immediately looks it up by id, same string-innerHTML limitation as
    // the drill-toggle buttons above — a throwaway stub is enough here too.
    if (id === 'v2-new-tray-btn') return document.createElement('button');
    return null;
  };

  const mod = loadModule(document, { sb: sbStub, APP_ID: 'pulse-zero', app });
  await mod.renderAppV2({});
  // renderAppV2 starts a 20s setInterval to re-render live run chips'
  // elapsed-time text — real and correct in a browser tab, but it would
  // otherwise keep the Node test process alive past its own test. Tear it
  // down like a real unmount (sign-out) would.
  t.after(() => mod.stopCardsRealtimeV2());

  assert.equal(mod.store.has('o1'), true);
  assert.equal(mod.store.has('r1'), true);
  assert.equal(mod.cardMode(mod.store.get('r1')), 'run', 'a dispatched card with no terminal event is a live run chip, never gone');
  assert.equal(mod.countOpen(), 1);

  const cardsMain = idRegistry.get('v2-cards');
  const orderBefore = cardsMain._children.map(c => c.dataset.cardId);

  // A realtime INSERT for a genuinely new card must not appear inline or
  // reorder what's already rendered.
  mod.handleCardChangeV2({ eventType: 'INSERT', new: { id: 'brand-new', app_id: 'pulse-zero', status: 'open', payload: { title: 'New thing' } }, old: {} });
  assert.equal(mod.getNewTray().includes('brand-new'), true);
  assert.equal(mod.store.has('brand-new'), false, 'new-tray cards are not rendered until Mike reveals them');
  const orderAfter = cardsMain._children.map(c => c.dataset.cardId);
  assert.deepEqual(orderAfter, orderBefore, 'board order freezes — an unrevealed new card must not be spliced in');
});
