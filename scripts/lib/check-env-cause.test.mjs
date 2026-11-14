// BRO-7138: the env-vs-real split of a failed recheck, pinned on the REAL
// latest-per-card fail rows of data/audit/autonomous-recheck-ledger.jsonl for
// 2026-10-09..11-08 (fixture: 85 rows, 300-char details as the ledger keeps them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { envCauseOf, needsTsxRunner } = require('./check-env-cause.js');
const { recheckVerdict, heldShare, heldShareLine, describeResult, doneClaimsHeldRow } = require('./autonomous-recheck-core.js');
const { tokenizeCheckCommand } = require('./autonomous-checks.js');

const rows = fs.readFileSync(path.join(here, '..', '..', 'tests', 'fixtures', 'recheck-real-fails-2026-11.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
// The three tests CI runs under tsx that the old recheck ran under plain node
// (tests/unit-test-manifest-tsx.txt lines as of 2026-11-08).
const TSX = new Set(['tests/unit/gate-logic.test.mjs', 'tests/unit/seo-show-no-venue.test.mjs', 'tests/unit/uk-regional-placement.test.mjs']);

test('real ledger: 18 could-not-run-here against 67 real fails', () => {
  const got = { env: 0, real: 0 };
  for (const r of rows) {
    const v = recheckVerdict(r, { tsxTests: TSX });
    assert.equal(v.envCause || 'real', r.expect, `${r.cardId}: ${r.detail.slice(0, 80)}`);
    got[v.envCause ? 'env' : 'real']++;
  }
  assert.deepEqual(got, { env: 18, real: 67 });
});

test('edges stay REAL: show missing, public-API fallback that ran, shallow-clone commit, deleted module', () => {
  for (const id of ['BRO-7055', 'BRO-6503', 'BRO-6594', 'BRO-5282']) {
    const r = rows.find((x) => x.cardId === id);
    assert.ok(r, id);
    assert.equal(recheckVerdict(r, { tsxTests: TSX }).status, 'fail', id);
  }
  // A genuinely missing module on a test NOT in the tsx manifests is a real regression.
  const deleted = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/auto-recheck-x/main/scripts/lib/gone.js'";
  assert.equal(envCauseOf(deleted, { argv: tokenizeCheckCommand('node --test tests/unit/other.test.mjs'), tsxTests: TSX }), null);
  // ...and also once a tsx-manifest test already runs under tsx (runVerify passes the run argv).
  assert.equal(envCauseOf(deleted, { argv: ['npx', 'tsx', '--test', 'tests/unit/gate-logic.test.mjs'], tsxTests: TSX }), null);
  assert.equal(envCauseOf("TS2307: Cannot find module './gone' or its corresponding type declarations."), null);
});

test('needsTsxRunner: only when every node --test file is tsx-listed', () => {
  assert.equal(needsTsxRunner(['node', '--test', 'tests/unit/gate-logic.test.mjs'], TSX), true);
  assert.equal(needsTsxRunner(['node', '--test', 'tests/unit/gate-logic.test.mjs', 'tests/unit/x.test.mjs'], TSX), false);
  assert.equal(needsTsxRunner(['node', 'scripts/x.js'], TSX), false);
});

test('rows written after the fix (unverifiable + envCause) read the same as old fail rows', () => {
  assert.deepEqual(recheckVerdict({ status: 'unverifiable', envCause: 'credential-withheld' }), { status: 'unverifiable', envCause: 'credential-withheld' });
  assert.deepEqual(recheckVerdict({ status: 'pass' }), { status: 'pass', envCause: null });
  assert.match(describeResult({ name: 'X', status: 'unverifiable', envCause: 'credential-withheld' }), /could not be checked, its check needs a password/);
  assert.equal(describeResult({ name: 'X', status: 'unverifiable' }), 'X: no way to check this automatically');
});

test('heldShare: latest verdict per card, env rows out of the share, null (not NaN) when nothing testable', () => {
  const now = Date.parse('2026-11-09T00:00:00Z');
  const e = (cardId, ts, status, extra = {}) => ({ event: 'recheck', cardId, ts, status, skip: null, ...extra });
  const entries = [
    e('A', '2026-11-01T07:00:00Z', 'fail'), e('A', '2026-11-02T07:00:00Z', 'pass'), // latest wins
    e('B', '2026-11-02T07:00:00Z', 'fail', { detail: 'FAIL UX resolution: LINEAR_API_KEY not set in .env or environment' }),
    e('C', '2026-11-02T07:00:00Z', 'fail', { detail: 'real regression' }),
    e('D', '2026-09-01T07:00:00Z', 'pass'), // outside window
    { event: 'recheck-summary', ts: '2026-11-02T07:00:00Z' },
  ];
  const h = heldShare(entries, { now, days: 30 });
  assert.deepEqual({ ...h }, { cards: 3, pass: 1, fail: 1, couldNotRun: 1, unverifiable: 0, days: 30, share: 0.5 });
  assert.equal(heldShare([], { now }).share, null);
  assert.match(heldShareLine(h, heldShare([], { now, days: 7 })), /^Done claims that held: 50% \(1 of 2\) over 30 days, nothing testable over 7 days; 1 more could not be checked/);
});

test('doneClaimsHeldRow: warns when the nightly recheck stopped writing, passes with the share line otherwise', () => {
  const now = Date.parse('2026-11-09T00:00:00Z');
  assert.match(doneClaimsHeldRow([], { now }).message, /never written a summary/);
  assert.equal(doneClaimsHeldRow([], { now }).status, 'warn');
  const stale = doneClaimsHeldRow([{ event: 'recheck-summary', ts: '2026-11-05T00:00:00Z' }], { now });
  assert.deepEqual([stale.status, /96h ago/.test(stale.message)], ['warn', true]);
  const ok = doneClaimsHeldRow([
    { event: 'recheck-summary', ts: '2026-11-08T07:00:00Z' },
    { event: 'recheck', cardId: 'A', ts: '2026-11-08T07:00:00Z', status: 'pass', skip: null },
  ], { now, tsxTests: new Set() });
  assert.equal(ok.status, 'pass');
  assert.match(ok.message, /^Done claims that held: 100% \(1 of 1\) over 30 days/);
});

test('recheckVerdict: a row classified at write time (has a sha key) is never re-derived (BRO-7138 review)', () => {
  const { recheckVerdict } = require('./check-env-cause.js');
  const tsx = new Set(['tests/unit/gate-logic.test.mjs']);
  const row = { cardId: 'BRO-1', status: 'fail', verifyCmd: 'node --test tests/unit/gate-logic.test.mjs', detail: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/w/src/lib/deleted.ts'" };
  // A legacy row (no sha key) is still re-derived, as before.
  assert.equal(recheckVerdict(row, { tsxTests: tsx }).status, 'unverifiable');
  // The same failure on a new row ran under tsx: it is a real failure.
  assert.deepEqual(recheckVerdict({ ...row, sha: 'abc' }, { tsxTests: tsx }), { status: 'fail', envCause: null });
  assert.deepEqual(recheckVerdict({ ...row, sha: null }, { tsxTests: tsx }), { status: 'fail', envCause: null });
});
