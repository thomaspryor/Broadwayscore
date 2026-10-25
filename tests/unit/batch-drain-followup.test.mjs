// Guards the 2026-08-29..31 opening-night regression at its decision point.
//
// scripts/llm-scoring/index.ts drains an in-flight vendor batch at the start of
// every invocation. A batch that was merely STILL IN FLIGHT used to set
// `skipNewWork = true`, and the scoring loop is `!skipNewWork && i < ...` — so
// one in-flight batch stopped the run scoring ANYTHING, including reviews for
// unrelated shows, then exited 0. The opening-night gate reads score_total === 0
// as "nothing to do", so the pipeline went green while scoring nothing.
//
// Requires the real function (CLAUDE.md §15): index.ts calls decideDrainFollowUp
// for both branches, so reverting the production behaviour fails these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideDrainFollowUp } = require('../../scripts/lib/batch-drain-decision.js');

const MANIFEST = [
  { filePath: 'data/review-texts/avenue-q-west-end-2026/independent--louis-chilton.json' },
];

test('an in-flight batch holds ONLY its own files and never stops the run', () => {
  const d = decideDrainFollowUp({ outcome: 'in-flight', manifest: MANIFEST });
  assert.equal(
    d.skipAllNewWork,
    false,
    'THE regression: an in-flight batch must not short-circuit the scoring loop'
  );
  assert.deepEqual(d.holdPaths, [MANIFEST[0].filePath]);
  assert.equal(d.keepState, true, 'the paid batch must still be drained next run');
});

test("an in-flight batch for show A does not hold show B's reviews", () => {
  const { holdPaths } = decideDrainFollowUp({ outcome: 'in-flight', manifest: MANIFEST });
  const otherShow = 'data/review-texts/the-house-of-the-negro-insane-off-broadway-2026/nyt--x.json';
  assert.ok(
    !holdPaths.includes(otherShow),
    'this is exactly what broke: show A blocked scoring for every other show'
  );
});

// The one case where parking the whole run IS correct — merging an
// unretrievable leg would write a degraded ensemble corpus-wide.
test('a refused merge still parks the entire run', () => {
  const d = decideDrainFollowUp({ outcome: 'refused', manifest: MANIFEST });
  assert.equal(d.skipAllNewWork, true);
  assert.equal(d.keepState, true);
});

test('merged and abandoned batches lock nothing and clear state', () => {
  for (const outcome of ['merged', 'abandoned']) {
    const d = decideDrainFollowUp({ outcome, manifest: MANIFEST });
    assert.deepEqual(d.holdPaths, [], `${outcome} must not hold files`);
    assert.equal(d.skipAllNewWork, false, `${outcome} must not stop the run`);
    assert.equal(d.keepState, false, `${outcome} must clear the batch state`);
  }
});

test('a malformed manifest degrades to holding nothing, not to crashing', () => {
  const d = decideDrainFollowUp({
    outcome: 'in-flight',
    manifest: [{}, { filePath: '' }, null, { filePath: 'ok.json' }],
  });
  assert.deepEqual(d.holdPaths, ['ok.json']);
  assert.equal(d.skipAllNewWork, false);
  assert.deepEqual(decideDrainFollowUp({ outcome: 'in-flight' }).holdPaths, []);
});

test('an unknown outcome throws rather than silently scoring held files', () => {
  assert.throws(() => decideDrainFollowUp({ outcome: 'nonsense' }), /unknown outcome/);
});
