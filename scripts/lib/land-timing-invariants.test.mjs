// land-timing-report.js missingInvariants / --check-invariants (BRO-7150). Fixture-only, no live data:
// kept apart from land-timing-report.test.mjs, one of whose tests reads data/audit/landings.jsonl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('./land-timing-report.js');

test('missingInvariants names per-file causes behind 3+ refusals not on the fast list (BRO-7150)', () => {
  const causes = [
    { cause: 'scripts-lib-tests: scripts/lib/a.test.mjs', refusals: 8 },
    { cause: 'unit-tests-node: tests/unit/on-list.test.mjs', refusals: 7 },
    { cause: 'unit-tests-node: tests/unit/slow.test.mjs', refusals: 5 },
    { cause: 'unit-tests-node: tests/unit/b.test.mjs', refusals: 3 },
    { cause: 'unit-tests-node: tests/unit/rare.test.mjs', refusals: 2 },
    { cause: 'lint-workflows: live-data-lane', refusals: 35 },
    { cause: 'rebase conflict (Checks)', refusals: 17 },
  ];
  assert.deepEqual(R.missingInvariants(causes, { invariants: ['tests/unit/on-list.test.mjs'], slow: new Set(['tests/unit/slow.test.mjs']) }), [
    { file: 'scripts/lib/a.test.mjs', gate: 'scripts-lib-tests', refusals: 8 },
    { file: 'tests/unit/b.test.mjs', gate: 'unit-tests-node', refusals: 3 },
  ]);
  assert.deepEqual(R.missingInvariants([], { invariants: [] }), []);
  // summed across gates (Codex review): 2 + 2 in two gates clears the 3-refusal bar
  assert.deepEqual(R.missingInvariants([{ cause: 'unit-tests-node: tests/unit/c.test.mjs', refusals: 2 }, { cause: 'scripts-lib-tests: tests/unit/c.test.mjs', refusals: 2 }], { invariants: [] }).map((m) => [m.file, m.refusals]), [['tests/unit/c.test.mjs', 4]]);
  assert.equal(R.parseArgs(['--check-invariants']).checkInvariants, true);
  assert.match(R.parseArgs(['--gates', '--check-invariants']).error, /--gates/);
});

test('the live fast list covers every test file this week\'s refusals named 3+ times (fixture of 2026-11-27 causes)', () => {
  const F = require('./land-fast-tests.js');
  const week = ['scripts-lib-tests: scripts/lib/tmpdir-for-tests.test.mjs', 'scripts-lib-tests: scripts/lib/review-write-safety.test.mjs',
    'unit-tests-node: scripts/audit-run-budget-slack.test.mjs', 'unit-tests-node: tests/unit/opening-night-lane-flaggers.test.mjs']
    .map((cause) => ({ cause, refusals: 3 }));
  assert.deepEqual(R.missingInvariants(week, { invariants: F.INVARIANT_TESTS, slow: F.SLOW_TESTS }), []);
});
