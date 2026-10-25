/**
 * health-check-unmeasurable-rows.test.mjs — BRO-4120 prevent-class guard.
 *
 * Rows that read a gitignored, per-machine ledger say "cannot be measured
 * from this environment" when health-check.js runs in CI. They had no
 * playbook entry, and isActionableResult() treats "no entry" as actionable,
 * so every CI run put them in the digest snapshot and digest-autofix filed
 * "BSC Daily:" cards nobody could fix from CI (BRO-4704..4708). Such rows now
 * carry `unmeasurable: true`. These tests require() the real predicates
 * (CLAUDE.md §15) and scan the real sources so a new "from this environment"
 * row without the flag fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isActionableResult, effectiveUrgencyLevel } = require('../health-check.js');
const { runReachabilityCheck } = require('../lib/cmux-reachability-check.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('an unmeasurable row is never actionable, even with no playbook entry', () => {
  const row = { name: 'Dispatch health: dead-launch rate (unmeasurable here)', status: 'warn', message: 'x' };
  assert.equal(isActionableResult(row), true, 'baseline: an entry-less row is actionable by default');
  assert.equal(isActionableResult({ ...row, unmeasurable: true }), false);
});

test('an unmeasurable row downgrades any static urgency to low (card filing path)', () => {
  assert.equal(effectiveUrgencyLevel('this-week', { unmeasurable: true }), 'low');
  assert.equal(effectiveUrgencyLevel('this-week', {}), 'this-week');
});

test('cmux reachability without cmux installed returns a flagged, non-actionable row', async () => {
  const r = await runReachabilityCheck({ dryRun: true, probeFn: () => ({ measurable: false }) });
  assert.equal(r.unmeasurable, true);
  assert.equal(isActionableResult(r), false);
});

test('every "cannot measure from this environment" row in the sources carries unmeasurable: true', () => {
  const MARKER = /\(unmeasurable here\)`|(visible|measurable|measure [\w -]+) from this environment|not measurable here/;
  const files = ['scripts/health-check.js', 'scripts/lib/cmux-reachability-check.js',
    'scripts/lib/autofix-canary.js', 'scripts/lib/digest-invariant-fail-monitor.js'];
  const missing = [];
  let seen = 0;
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
      if (!MARKER.test(line)) return;
      seen++;
      const window = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
      if (!/\bunmeasurable: true\b/.test(window)) missing.push(`${rel}:${i + 1}`);
    });
  }
  assert.ok(seen >= 9, `expected the 9 known rows, scanned ${seen}`);
  assert.deepEqual(missing, []);
});
