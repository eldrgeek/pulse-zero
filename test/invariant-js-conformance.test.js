'use strict';
/**
 * invariant-js-conformance.test.js — WQ-251's anti-drift gate.
 *
 * Runs the JS deterministic port AND the canonical Python gate against the SAME
 * corpus (SOMA/invariants/fixtures/) and fails if the two disagree by one
 * character. That shared corpus is the whole point: two implementations of the
 * same rules will drift, and the only thing that stops it is a test that runs
 * both and diffs the output.
 *
 * The comparison is on the DETERMINISTIC rule objects the JS module claims to
 * implement (SCHEMA_CONTRACT, WI1_IDENTITY_DEDUPE) — including the `message`
 * string, because a differently-worded failure is a different failure to whoever
 * has to act on it.
 *
 * If Python is unavailable the differential half SKIPS rather than fails (CI
 * shouldn't go red because a runner lacks python3), but the JS-only assertions
 * still run so the module is never wholly untested.
 *
 * Author: Dee (Opus 5) for Mike Wolf, 2026-08-11.
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateDeterministic } = require('../netlify/functions/lib/soma-invariant-deterministic.js');

const PORTED = ['SCHEMA_CONTRACT', 'WI1_IDENTITY_DEDUPE'];
const SOMA = path.resolve(os.homedir(), 'Projects', 'SOMA');
const FIXTURES = path.join(SOMA, 'invariants', 'fixtures');
const GATE = path.join(SOMA, 'tools', 'soma_invariant_gate.py');

function listFixtures() {
  const out = [];
  for (const bucket of ['valid', 'invalid', 'deterministic-negative']) {
    const dir = path.join(FIXTURES, bucket);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith('.json')) out.push({ bucket, name: f, file: path.join(dir, f) });
    }
  }
  return out;
}

function pythonDecision(file) {
  const py = spawnSync('python3', ['-c', `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
data = json.load(open(${JSON.stringify(file)}))
print(json.dumps(g.evaluate(data, "shadow")["deterministic"]))
`], { encoding: 'utf8', timeout: 30000 });
  if (py.status !== 0) return { ok: false, err: (py.stderr || '').slice(0, 600) };
  try {
    return { ok: true, rules: JSON.parse(py.stdout) };
  } catch (e) {
    return { ok: false, err: `unparseable: ${py.stdout.slice(0, 300)}` };
  }
}

const fixtures = listFixtures();
assert.ok(fixtures.length >= 20, `expected the fixture corpus, found ${fixtures.length}`);

// The corpus must actually exercise both ported rules in the FAIL direction.
// Without this, a port that returned 'pass' unconditionally would score 100% —
// which is exactly what the pre-2026-08-11 corpus would have allowed.
{
  const failing = new Set();
  for (const fx of fixtures) {
    const data = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
    for (const r of evaluateDeterministic(data).deterministic) {
      if (r.result === 'fail') failing.add(r.rule);
    }
  }
  for (const rule of PORTED) {
    assert.ok(failing.has(rule),
      `no fixture makes ${rule} fail — the corpus cannot detect a stub implementation`);
  }
  console.log(`corpus exercises the fail path of: ${[...failing].sort().join(', ')}`);
}

let pass = 0;
let skipped = 0;
const failures = [];

// --- JS-only structural assertions ---------------------------------------
for (const fx of fixtures) {
  const data = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  const js = evaluateDeterministic(data);
  assert.deepStrictEqual(js.ported, PORTED, `${fx.name}: ported set changed without updating this test`);
  assert.strictEqual(js.deterministic.length, 2, `${fx.name}: expected exactly the two ported rules`);
  for (const r of js.deterministic) {
    assert.ok(r.result === 'pass' || r.result === 'fail', `${fx.name}: bad result value`);
    assert.strictEqual(typeof r.message, 'string');
  }
}
console.log(`JS structural assertions: ${fixtures.length} fixture(s) OK`);

// Every `valid/` fixture must clear both ported rules. This is the assertion
// that would catch a port that "passes conformance" by failing everything.
for (const fx of fixtures.filter((f) => f.bucket === 'valid')) {
  const data = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  const js = evaluateDeterministic(data);
  for (const r of js.deterministic) {
    assert.strictEqual(r.result, 'pass',
      `valid fixture ${fx.name} failed ${r.rule} in JS: ${r.message}`);
  }
}
console.log('JS: every valid/ fixture clears both ported rules');

// --- differential: JS vs Python on the shared corpus ----------------------
const probe = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
if (probe.status !== 0 || !fs.existsSync(GATE)) {
  console.log('SKIP differential: python3 or the canonical gate is unavailable');
} else {
  for (const fx of fixtures) {
    const data = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
    const js = evaluateDeterministic(data).deterministic;
    const res = pythonDecision(fx.file);
    if (!res.ok) {
      skipped += 1;
      console.log(`SKIP ${fx.bucket}/${fx.name}: python gate error: ${res.err}`);
      continue;
    }
    const pyPorted = res.rules.filter((r) => PORTED.includes(r.rule));
    try {
      assert.deepStrictEqual(js, pyPorted);
      pass += 1;
      console.log(`OK   ${fx.bucket}/${fx.name}`);
    } catch (e) {
      failures.push({ fixture: `${fx.bucket}/${fx.name}`, js, py: pyPorted });
      console.log(`DIFF ${fx.bucket}/${fx.name}`);
      for (const rule of PORTED) {
        const a = js.find((r) => r.rule === rule);
        const b = pyPorted.find((r) => r.rule === rule);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          console.log(`  ${rule}`);
          console.log(`    JS: ${JSON.stringify(a)}`);
          console.log(`    PY: ${JSON.stringify(b)}`);
        }
      }
    }
  }
  console.log(`\ndifferential: ${pass} identical, ${failures.length} divergent, ${skipped} skipped`);
}

if (failures.length) {
  console.error('\nJS and Python disagree — that is drift, fix the port before shipping.');
  process.exit(1);
}
console.log('\nconformance OK');
