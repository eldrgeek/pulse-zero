// Named addressee badge (2026-08-27): routing metadata, not a second owner.
// Default is Mike (no badge). Rook gets a "to rook" badge. Unknown slugs
// omit the badge (fail closed). No live Discord.
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
    script + '\nreturn { cardAddressee, addresseeBadge, titleBadges, DEFAULT_ADDRESSEE, KNOWN_SEATS };'
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

test('known seats are mike and rook — lockstep with bin/pulse_seats.py', () => {
  assert.equal(ui.DEFAULT_ADDRESSEE, 'mike');
  assert.ok(ui.KNOWN_SEATS instanceof Set);
  assert.deepEqual([...ui.KNOWN_SEATS].sort(), ['mike', 'rook']);
});

test('unknown slug does not render as a seat badge (fail closed)', () => {
  // A typo --to must not look like a real seat. validate_payload already
  // rejects unknowns on write; the board still fail-closes if a row lands.
  const typo = { payload: { addressee: 'rok', title: 'Review the PR' } };
  assert.equal(ui.cardAddressee(typo), 'mike');
  assert.equal(ui.addresseeBadge(typo), '');
  assert.doesNotMatch(ui.titleBadges(typo), /addressee/);
  assert.doesNotMatch(ui.titleBadges(typo), /rok/i);

  const skip = { created_by: 'skip', payload: { addressee: 'skip', title: 'X' } };
  assert.equal(ui.cardAddressee(skip), 'mike');
  assert.equal(ui.addresseeBadge(skip), '');
  assert.doesNotMatch(ui.titleBadges(skip), /to skip/i);

  const escaped = { payload: { addressee: '<img src=x>', title: 'X' } };
  assert.equal(ui.cardAddressee(escaped), 'mike');
  assert.equal(ui.addresseeBadge(escaped), '');
  assert.doesNotMatch(ui.titleBadges(escaped), /addressee/);
  assert.doesNotMatch(ui.titleBadges(escaped), /img/i);
});

test('herm profiles are not seats and do not badge', () => {
  for (const name of ['rally', 'mae', 'greta', 'Rally']) {
    const c = { payload: { addressee: name, title: 'X' } };
    assert.equal(ui.cardAddressee(c), 'mike', name);
    assert.equal(ui.addresseeBadge(c), '', name);
    assert.doesNotMatch(ui.titleBadges(c), /addressee/);
  }
});
