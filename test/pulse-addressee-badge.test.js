// Named addressee badge (2026-08-27): routing metadata, not a second owner.
// Default is Mike (no badge). Rook gets a "to rook" badge. No live Discord.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const match = html.match(/<script>\s*(const SUPABASE_URL[\s\S]*?)<\/script>/);
if (!match) throw new Error('main Pulse script was not found');
let script = match[1];
script = script.replace(/^boot\(\);?\s*$/m, '// removed for test');

function load() {
  const globals = {
    document: { querySelector: () => null, getElementById: () => null, addEventListener: () => {} },
    window: { supabase: { createClient: () => ({}) }, addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { userAgent: 'node' },
    location: { search: '' },
  };
  const fn = new Function(
    ...Object.keys(globals),
    script + '\nreturn { cardAddressee, addresseeBadge, titleBadges, DEFAULT_ADDRESSEE };'
  );
  return fn(...Object.values(globals));
}

const ui = load();

test('default addressee is mike and does not render a badge', () => {
  assert.equal(ui.DEFAULT_ADDRESSEE, 'mike');
  assert.equal(ui.cardAddressee({ payload: {} }), 'mike');
  assert.equal(ui.cardAddressee({}), 'mike');
  assert.equal(ui.addresseeBadge({ payload: { title: 'X' } }), '');
  assert.equal(ui.addresseeBadge({ payload: { addressee: 'mike' } }), '');
});

test('rook addressee renders a to-rook badge and is not provenance', () => {
  const c = { created_by: 'skip', payload: { addressee: 'Rook', title: 'Review the PR' } };
  assert.equal(ui.cardAddressee(c), 'rook');
  const badge = ui.addresseeBadge(c);
  assert.match(badge, /class="addressee"/);
  assert.match(badge, /to rook/i);
  assert.doesNotMatch(badge, /skip/);
  assert.match(ui.titleBadges(c), /addressee/);
});
