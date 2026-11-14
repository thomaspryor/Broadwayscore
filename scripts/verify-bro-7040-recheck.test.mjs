/**
 * verify-bro-7040-recheck.test.mjs: RECHECK-AFTER acceptance for BRO-7040
 * (quiet morning digest: 48h warning hold, first-seen bookkeeping).
 *
 * Asserts against the LIVE health snapshot and history, not a fixture. The
 * change landed 2026-11-06. Once two nightly health-check runs have happened
 * since, every open row in the digest snapshot must carry a firstSeen stamp
 * and the history file must hold the firstSeen/cleared/openStatus maps. A
 * missing stamp means health-check.js stopped recording age and the digest
 * silently went back to showing every warning on day one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CHECKABLE_FROM = Date.parse('2026-11-08T12:00:00Z');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', f), 'utf8'));

test('digest snapshot rows carry firstSeen after the change landed', { skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-08' }, () => {
  const snap = read('health-digest-snapshot.json');
  assert.ok(Date.parse(snap.generatedAt) >= Date.parse('2026-11-07T00:00:00Z'), 'snapshot not regenerated since the change landed');
  const rows = [...(snap.errors || []), ...(snap.warns || [])];
  const missing = rows.filter((r) => typeof r.firstSeen !== 'string' || !Number.isFinite(Date.parse(r.firstSeen))).map((r) => r.name);
  assert.deepEqual(missing, [], 'rows without a firstSeen stamp');
  assert.equal(typeof snap.cleared, 'object', 'snapshot lost its cleared map');
});

test('history keeps the first-seen maps', { skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-08' }, () => {
  const h = read('health-check-history.json');
  for (const k of ['firstSeen', 'cleared', 'openStatus']) assert.equal(typeof h[k], 'object', `history.${k} missing`);
});

// RECHECK-GREEN-TODAY: pure-function check, passes now and must keep passing.
test('the hold logic still exists and holds a young warning', () => {
  const { isSettling, SETTLE_HOURS } = require('./lib/health-first-seen');
  const now = Date.now();
  assert.equal(SETTLE_HOURS, 48);
  assert.equal(isSettling({ name: 'x', firstSeen: new Date(now - 3600e3).toISOString() }, 'warn', now), true);
  assert.equal(isSettling({ name: 'x', firstSeen: new Date(now - 3600e3).toISOString() }, 'error', now), false);
});
