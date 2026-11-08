// land-timing-report.js (BRO-7150): refusal causes, run outcomes and the before/after split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('./land-timing-report.js');

test('median handles odd, even and empty input', () => {
  assert.equal(R.median([3, 1, 2]), 2);
  assert.equal(R.median([4, 1, 2, 3]), 2.5);
  assert.equal(R.median([]), null);
});

test('causeFromMessage keys each refusal shape', () => {
  assert.equal(R.causeFromMessage('unit-tests-node: NEW failure on the branch (absent on origin/main): scripts/tests/global-instructions.test.mjs::CLOUD.md keeps headroom'),
    'unit-tests-node: scripts/tests/global-instructions.test.mjs');
  assert.equal(R.causeFromMessage('lint-workflows: NEW failure on the branch (absent on origin/main): lint-workflows::audit-timeouts'),
    'lint-workflows: audit-timeouts');
  assert.equal(R.causeFromMessage('lint-workflows gate failed: audit-x (exit 1)'), 'lint-workflows: audit-x');
  assert.equal(R.causeFromMessage('land/x does not rebase cleanly onto origin/main'), 'rebase conflict (Checks)');
  assert.equal(R.causeFromMessage('land/x was NOT landed — rebase: conflict'), 'rebase conflict (at landing)');
  assert.equal(R.causeFromMessage('land/x was NOT landed — protected: refused'), 'landing refused: protected');
  assert.equal(R.causeFromMessage('Process completed with exit code 1.'), null);
});

test('causesFromAnnotations falls back to the first failing gate', () => {
  const ann = [
    { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    { annotation_level: 'failure', message: 'checks RED — first failing gate: tsc' },
    { annotation_level: 'warning', message: 'tsc gate failed: ignored (warning)' },
  ];
  assert.deepEqual(R.causesFromAnnotations(ann), ['tsc (no per-test annotation)']);
});

const run = (o = {}) => ({ id: 1, head_branch: 'land/x', run_started_at: '2026-11-08T10:00:00Z', status: 'completed', conclusion: 'success', ...o });

test('summarizeRun: landed, refused and other', () => {
  const landed = R.summarizeRun(run(), [
    { name: 'Checks', conclusion: 'success', steps: [] },
    { name: 'Land', conclusion: 'success', completed_at: '2026-11-08T10:25:00Z', steps: [] },
  ]);
  assert.equal(landed.outcome, 'landed');
  assert.equal(landed.minutes, 25);
  assert.equal(landed.fast, false);

  const refused = R.summarizeRun(run({ conclusion: 'failure' }), [
    { name: 'Checks', conclusion: 'failure', completed_at: '2026-11-08T10:03:00Z', steps: [{ name: 'Fast-fail — cheap tests first', conclusion: 'failure' }] },
  ]);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.minutes, 3);
  assert.equal(refused.fast, true);
  assert.deepEqual(refused.causes, ['fast-fail (no per-test annotation)']);

  assert.equal(R.summarizeRun(run({ conclusion: 'cancelled' }), []).outcome, 'other');
  assert.equal(R.summarizeRun(run({ status: 'in_progress' }), []).outcome, 'other');
});

test('report splits before/after by the fast-fail step or an explicit time', () => {
  const recs = [
    { outcome: 'refused', minutes: 30, causes: ['a'], fast: false, started: '2026-11-08T09:00:00Z' },
    { outcome: 'refused', minutes: 3, causes: ['a', 'b'], fast: true, started: '2026-11-08T12:00:00Z' },
    { outcome: 'landed', minutes: 20, causes: [], fast: true, started: '2026-11-08T12:30:00Z' },
  ];
  const rep = R.report(recs);
  assert.equal(rep.before.medianMinutesToRefusal, 30);
  assert.equal(rep.after.medianMinutesToRefusal, 3);
  assert.equal(rep.after.medianMinutesToLand, 20);
  assert.deepEqual(rep.all.causes[0], { cause: 'a', refusals: 2 });
  assert.equal(R.report(recs, { split: '2026-11-08T12:15:00Z' }).after.runs, 1);
});

test('parseArgs validates input', () => {
  assert.equal(R.parseArgs(['--days=3', '--json']).days, 3);
  assert.ok(R.parseArgs(['--days=0']).error);
  assert.ok(R.parseArgs(['--bogus']).error);
  assert.ok(R.parseArgs(['--split=not-a-date']).error);
});
