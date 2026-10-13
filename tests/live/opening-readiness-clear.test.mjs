/**
 * LIVE acceptance test: the VERIFY line on cards filed by
 * scripts/route-readiness-failure.js (BRO-3038).
 *
 * Passes when no 'opening-readiness:failed:<show>' condition is open in the
 * CI alert ledger on origin/main for a show that has not opened yet. A show
 * that already opened is past saving by a readiness fix, so its leftover
 * condition must not block another show's card. check-opening-night-readiness.yml resolves
 * the condition on any passing run and commits the ledger, so this goes green
 * only after someone fixed the cause and the re-run passed. Lives in
 * tests/live/ (no unit manifest): its answer depends on CI state, not code.
 *
 *   node --test tests/live/opening-readiness-clear.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { CONDITION_PREFIX } = require('../../scripts/route-readiness-failure.js');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// openingDate per show id; an unreadable shows.json counts every condition.
function openingDates() {
  try {
    const { shows } = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
    return new Map(shows.map((s) => [s.id, s.openingDate]));
  } catch {
    return new Map();
  }
}

test('no opening-night readiness failure is still open on origin/main', () => {
  const today = new Date().toISOString().slice(0, 10);
  const opens = openingDates();
  execSync('git fetch -q origin main', { stdio: 'ignore' });
  const ledger = JSON.parse(execSync('git show origin/main:data/audit/alert-ledger.json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const open = Object.entries(ledger.conditions || {})
    .filter(([k, c]) => k.startsWith(CONDITION_PREFIX) && c && c.status === 'open')
    .filter(([k]) => { const d = opens.get(k.slice(CONDITION_PREFIX.length)); return !d || d >= today; })
    .map(([k]) => k);
  assert.deepEqual(open, [], `still open (re-run check-opening-night-readiness.yml for the show after fixing): ${open.join(', ')}`);
});
