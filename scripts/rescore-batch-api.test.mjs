/**
 * BRO-7807: bulk rescore runs are batch-only (half price); only single-show
 * (opening-night) runs stay synchronous. Also pins the cheaper-model A/B
 * evidence and that the workflow routes through the tested policy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { isRescoreRun, shouldBatchScoring, shouldBatchComparative } = require('./lib/rescore-batch-policy.js');
const models = require('./lib/models.js');

describe('shouldBatchScoring', () => {
  const rescoreFlags = [
    { needsRescore: 'true' }, { runRescore: 'true' }, { rescore: 'true' }, { outdated: 'true' },
    { staleScores: 'true' }, { upgradeEnsemble: 'true' }, { rescoreReason: 'fullText added' },
  ];
  for (const f of rescoreFlags) {
    test(`manual dispatch ${JSON.stringify(f)} batches`, () => {
      assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', ...f }), true);
    });
    test(`chain link ${JSON.stringify(f)} batches (was sync before BRO-7807)`, () => {
      assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', chain: 'true', ...f }), true);
    });
  }
  test('scheduled non-chain run still batches', () => {
    assert.equal(shouldBatchScoring({ eventName: 'schedule' }), true);
  });
  test('plain non-rescore chain/dispatch stays sync (unchanged)', () => {
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', chain: 'true' }), false);
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch' }), false);
  });
  test('single-show dispatch stays sync even with a rescore reason (press-night path)', () => {
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', showId: 'x-2026', rescoreReason: 'auto-rescore-x-2026' }), false);
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', showId: 'x-2026', needsRescore: 'true' }), false);
  });
  test('kill switch and dry run force sync / no paid batch', () => {
    assert.equal(shouldBatchScoring({ eventName: 'schedule', disableBatch: '1' }), false);
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', needsRescore: 'true', disableBatch: '1' }), false);
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', needsRescore: 'true', dryRun: 'true' }), false);
  });
  test('isRescoreRun ignores empty strings', () => {
    assert.equal(isRescoreRun({ needsRescore: 'false', rescoreReason: '  ' }), false);
  });
});

describe('shouldBatchComparative (the gpt-4o leg)', () => {
  test('chain, schedule and bulk dispatch all batch', () => {
    for (const eventName of ['schedule', 'workflow_dispatch']) {
      for (const chain of ['true', 'false']) assert.equal(shouldBatchComparative({ eventName, chain }), true);
    }
  });
  test('single-show stays sync; kill switch off', () => {
    assert.equal(shouldBatchComparative({ showId: 'x-2026' }), false);
    assert.equal(shouldBatchComparative({ disableBatch: '1' }), false);
  });
});

describe('workflow is wired to the policy (no hand-rolled schedule-only gate)', () => {
  const wf = readFileSync(join(root, '.github/workflows/llm-ensemble-score.yml'), 'utf8');
  test('both passes call rescore-batch-policy.js', () => {
    assert.equal((wf.match(/scripts\/lib\/rescore-batch-policy\.js/g) || []).length >= 3, true); // 2 comments+calls
    assert.match(wf, /rescore-batch-policy\.js comparative\)/);
    assert.match(wf, /rescore-batch-policy\.js\)" == "true" \]; then\s+#[^\n]*\n(?:\s+#[^\n]*\n)*\s+ARGS="\$ARGS --batch/);
  });
  test('the old schedule-only batch condition is gone', () => {
    assert.doesNotMatch(wf, /event_name }}" == "schedule" \] \\\n\s+&& \[ "\${{ github\.event\.inputs\.chain }}" != "true" \]/);
    assert.doesNotMatch(wf, /"schedule" \] && \[ "\$\{\{ github\.event\.inputs\.chain \}\}" != "true" \] && \[ "\$\{\{ vars\.DISABLE_BATCH_SCORING/);
  });
});

describe('cheaper-model A/B evidence (CLAUDE.md rule 13)', () => {
  const ab = JSON.parse(readFileSync(join(root, 'data/audit/scoring-ab-2026-11-gpt-5.6-luna-shows.json'), 'utf8'));
  test('widened per-show A/B passed: >2 shows, every gate, bucket shift under 5pp', () => {
    assert.equal(ab.allPass, true);
    assert.ok(ab.gates.showDrift.value.showsChecked > 2, 'per-show check must exceed the original 2 shows');
    const shifts = Object.values(ab.gates.bucketShiftPp.value).map(Math.abs);
    assert.ok(Math.max(...shifts) < ab.gates.bucketShiftPp.limit);
  });
  test('ensemble leg is on the A/B-validated cheaper model; comparative stays gpt-4o until its own A/B', () => {
    assert.equal(models.SCORING_OPENAI, 'gpt-5.6-luna');
    assert.equal(models.COMPARATIVE_OPENAI, 'gpt-4o');
  });
});
