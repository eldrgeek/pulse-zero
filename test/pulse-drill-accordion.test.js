// Regression test for the 2026-08-13 unified drill-down accordion
// (public/index.html: drillMarkup/toggleDrill/togglePin/wireDrill).
//
// Mike's ask: opening one drill closes every other OPEN, UNPINNED drill by
// default; a pinned drill stays open. No DOM library dependency (project
// convention — see pulse-core's "zero external deps" and the rest of this
// suite's hand-rolled fixtures) — a tiny fake `document` that supports the
// exact `[data-drill-*="id"]` attribute-selector lookups the real functions
// use is enough to exercise the real logic, not a reimplementation of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const match = html.match(/<script>\s*(const SUPABASE_URL[\s\S]*?)<\/script>/);
if (!match) throw new Error('main Pulse script was not found');
let script = match[1];
// Neutralize the couple of top-level (not-inside-a-function) statements
// that touch the live DOM/network at parse time. We only need the
// drill-accordion functions, which are pure aside from DOM lookups our
// fake `document` intercepts.
script = script.replace(/^boot\(\);?\s*$/m, '// removed for test');

function makeFakeDom() {
  const elements = new Map(); // "[data-drill-toggle=\"id\"]" style key -> element

  function makeElement(attrs) {
    const el = {
      _attrs: { ...attrs },
      style: { display: '' },
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      setAttribute(k, v) { el._attrs[k] = String(v); },
      getAttribute(k) { return el._attrs[k] ?? null; },
    };
    return el;
  }

  function register(attrName, id) {
    const el = makeElement({ [attrName]: id, 'aria-expanded': 'false', 'aria-pressed': 'false' });
    elements.set(`[${attrName}="${id}"]`, el);
    return el;
  }

  const document = {
    querySelector(selector) {
      return elements.get(selector) || null;
    },
    getElementById: () => null,
    addEventListener: () => {},
  };

  return { document, register };
}

function loadModule(document) {
  const globals = {
    document,
    window: {
      supabase: { createClient: () => ({}) },
      addEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { userAgent: 'node' },
    location: { search: '' },
  };
  const fn = new Function(
    ...Object.keys(globals),
    script + '\nreturn { toggleDrill, togglePin, setDrillOpen, uiState };'
  );
  return fn(...Object.values(globals));
}

test('opening a drill closes every other open, unpinned drill', () => {
  const { document, register } = makeFakeDom();
  register('data-drill-toggle', 'steps:card1');
  register('data-drill-body', 'steps:card1');
  register('data-drill-toggle', 'steps:card2');
  register('data-drill-body', 'steps:card2');
  const mod = loadModule(document);

  mod.toggleDrill('steps:card1');
  assert.equal(mod.uiState.openDrills.has('steps:card1'), true);

  mod.toggleDrill('steps:card2');
  assert.equal(mod.uiState.openDrills.has('steps:card1'), false, 'opening card2 should close card1');
  assert.equal(mod.uiState.openDrills.has('steps:card2'), true);
});

test('a pinned drill stays open when another drill opens', () => {
  const { document, register } = makeFakeDom();
  register('data-drill-toggle', 'brief:x');
  register('data-drill-body', 'brief:x');
  register('data-drill-pin', 'brief:x');
  register('data-drill-toggle', 'steps:y');
  register('data-drill-body', 'steps:y');
  const mod = loadModule(document);

  mod.toggleDrill('brief:x');
  mod.togglePin('brief:x');
  assert.equal(mod.uiState.pinnedDrills.has('brief:x'), true);

  mod.toggleDrill('steps:y');
  assert.equal(mod.uiState.openDrills.has('brief:x'), true, 'pinned drill must survive another opening');
  assert.equal(mod.uiState.openDrills.has('steps:y'), true, 'the newly opened drill is also open');
});

test('clicking an open drill again closes just that one (no pin needed)', () => {
  const { document, register } = makeFakeDom();
  register('data-drill-toggle', 'steps:a');
  register('data-drill-body', 'steps:a');
  const mod = loadModule(document);

  mod.toggleDrill('steps:a');
  assert.equal(mod.uiState.openDrills.has('steps:a'), true);
  mod.toggleDrill('steps:a');
  assert.equal(mod.uiState.openDrills.has('steps:a'), false);
});

test('unpinning a drill makes it closeable by the next opened drill again', () => {
  const { document, register } = makeFakeDom();
  register('data-drill-toggle', 'brief:x');
  register('data-drill-body', 'brief:x');
  register('data-drill-toggle', 'steps:y');
  register('data-drill-body', 'steps:y');
  const mod = loadModule(document);

  mod.toggleDrill('brief:x');
  mod.togglePin('brief:x');
  assert.equal(mod.uiState.pinnedDrills.has('brief:x'), true);
  mod.togglePin('brief:x'); // unpin
  assert.equal(mod.uiState.pinnedDrills.has('brief:x'), false);

  mod.toggleDrill('steps:y');
  assert.equal(mod.uiState.openDrills.has('brief:x'), false, 'no-longer-pinned drill should close');
});
