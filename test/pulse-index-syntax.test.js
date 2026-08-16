const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('Pulse board main script compiles with typed action wiring present', () => {
  const match = html.match(/<script>\s*(const SUPABASE_URL[\s\S]*?)<\/script>/);
  assert(match, 'main Pulse script was not found');
  assert.doesNotThrow(() => new Function(match[1]));
  assert(match[1].includes('cardActionsPanel(c)'));
  assert(match[1].includes('wireTypedCardActions(div, c, onDone)'));
});
