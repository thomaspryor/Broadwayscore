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
    { staleScores: 'true' }, { upgradeEnsemble: 'true' },
  ];
  for (const f of rescoreFlags) {
    test(`manual dispatch ${JSON.stringify(f)} batches`, () => {
      assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', ...f }), true);
    });
  }
  test('chain links batch only for needs_rescore (cron can resume it); other flag chains stay sync', () => {
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', chain: 'true', needsRescore: 'true' }), true);
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', chain: 'true', runRescore: 'true' }), true);
    for (const f of ['outdated', 'staleScores', 'upgradeEnsemble', 'rescore']) {
      assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', chain: 'true', [f]: 'true' }), false, f);
    }
  });
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
  test('rescore_reason lane and sync=true stay sync (shared batch-state slot / human escape hatch)', () => {
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', needsRescore: 'true', rescoreReason: 'fullText added' }), false);
    assert.equal(shouldBatchScoring({ eventName: 'workflow_dispatch', needsRescore: 'true', sync: 'true' }), false);
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
  test('is the main-pass decision: urgent plain catch-up chain stays sync, bulk rescore batches', () => {
    assert.equal(shouldBatchComparative({ eventName: 'workflow_dispatch', chain: 'true' }), false);
    assert.equal(shouldBatchComparative({ eventName: 'workflow_dispatch', chain: 'true', needsRescore: 'true' }), true);
    assert.equal(shouldBatchComparative({ eventName: 'workflow_dispatch', chain: 'true', outdated: 'true' }), false);
    assert.equal(shouldBatchComparative({ eventName: 'schedule' }), true);
    assert.equal(shouldBatchComparative({ eventName: 'schedule', showId: 'x-2026' }), false);
  });
});

describe('workflow is wired to the policy (no hand-rolled schedule-only gate)', () => {
  const wf = readFileSync(join(root, '.github/workflows/llm-ensemble-score.yml'), 'utf8');
  test('both passes call rescore-batch-policy.js', () => {
    assert.equal((wf.match(/node scripts\/lib\/rescore-batch-policy\.js\)" == "true"/g) || []).length, 2); // main + comparative
    assert.match(wf, /rescore-batch-policy\.js\)" == "true" \]; then\s+#[^\n]*\n(?:\s+#[^\n]*\n)*\s+ARGS="\$ARGS --batch/);
  });
  test('each call site passes every env var the policy CLI reads', () => {
    const cli = readFileSync(join(root, 'scripts/lib/rescore-batch-policy.js'), 'utf8');
    const names = [...cli.matchAll(/\be\.([A-Z_]+)/g)].map((m) => m[1]);
    assert.ok(names.length >= 12);
    const sites = wf.split('node scripts/lib/rescore-batch-policy.js)" == "true"').slice(0, 2);
    for (const [n, site] of sites.entries()) {
      const block = site.slice(site.lastIndexOf('$(EVENT_NAME'));
      for (const name of names) assert.ok(block.includes(`${name}=`), `call site ${n} missing ${name}=`);
    }
  });
  test('chain step forwards sync=true so later links honour the escape hatch', () => {
    assert.ok(wf.includes('if [ "${INPUT_SYNC}" = "true" ]; then CHAIN_ARGS="$CHAIN_ARGS -f sync=true"; fi'));
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
  test('ensemble leg and comparative rescore are on the A/B-validated cheaper model', () => {
    assert.equal(models.SCORING_OPENAI, 'gpt-5.6-luna');
    assert.equal(models.COMPARATIVE_OPENAI, 'gpt-5.6-luna');
  });
  test('comparative A/B (BRO-7341) passed rule 13 on its own sample', () => {
    const cab = JSON.parse(readFileSync(join(root, 'data/audit/comparative-openai-ab-2026-11.json'), 'utf8'));
    assert.equal(cab.allPass, true);
    assert.equal(cab.candidate, models.COMPARATIVE_OPENAI);
    assert.ok(cab.reviews >= 20, 'A/B sample too small');
    assert.ok(Math.abs(cab.candidateVsControl.meanDrift.value) <= 5);
    assert.ok(Math.max(...Object.values(cab.candidateVsControl.bucketShiftPp.value).map(Math.abs)) <= 5);
  });
});
