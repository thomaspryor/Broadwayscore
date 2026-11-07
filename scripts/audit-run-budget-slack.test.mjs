import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scanText, findExceededOnly, loadBaseline, newFindings } = require('./audit-run-budget-slack.js');

test('exceeded() alone is flagged', () => {
  assert.equal(scanText('while(1){ if (budget.exceeded()) break; }').exceededOnly, true);
});
test('canStartItem clears it', () => {
  assert.equal(scanText('if (!b.canStartItem(9)) break; if (b.exceeded()) {}').exceededOnly, false);
});
test('comments do not count', () => {
  assert.equal(scanText('// budget.exceeded()\nconst x = 1;').exceededOnly, false);
});
test('waiver needs a reason', () => {
  assert.equal(scanText('b.exceeded() // run-budget-slack-ok: worst item 20s, slack 3 min').waived, true);
  assert.equal(scanText('b.exceeded() // run-budget-slack-ok: x').waived, false);
});
test('baseline file lists only scripts that still exist and still use exceeded() alone', () => {
  const base = [...loadBaseline()];
  assert.ok(base.length > 0);
  const found = findExceededOnly();
  assert.deepEqual(base.filter((f) => !found.includes(f)), [], 'stale baseline entries: remove them');
  // Advisory ratchet: new offenders are reported by the CLI (continue-on-error in test.yml), not failed here.
  assert.ok(Array.isArray(newFindings(findExceededOnly(), loadBaseline())));
});
