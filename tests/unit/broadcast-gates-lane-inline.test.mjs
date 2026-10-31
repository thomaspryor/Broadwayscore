// BRO-6623 (Cutover 9): the opening-night broadcast gates accept a lane-only night.
// The BRO-5201 recorded replay of A Few Good Men is run with the production inline scorer shape
// (inline-score.js ensembleScoreText over a stubbed scoreReviewFile, so no LLM calls). Its written review files and
// published rows then go through the REAL gate functions (CLAUDE.md section 15):
//   readiness  - broadcast-readiness.js evaluateBroadcastReadiness (workflow step + missed-broadcasts.js)
//   orphan     - verify-all-scored.js isScoreableSurvivor + hasValidScore (dispatch-orphan-rescore-requeue.js)
//   consensus  - critic-consensus-eligibility.js liveScoredCounts + critic-consensus-inputs.js loadReviewTexts
//   send floor - score-confidence-gate.js evaluateScoreConfidence (send-opening-night-broadcast.js)
// Both reviews.json shapes are covered: the raw lane rows publish.js writes during the lease, and the rows
// rebuild-all-reviews.js writes afterwards (which drop openingNightLane and carry laneSource instead).
// Run: node --test tests/unit/broadcast-gates-lane-inline.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const night = require('../../scripts/lib/lane-recorded-nights/a-few-good-men-2026.js');
const inline = require('../../scripts/lib/opening-night-lane/inline-score.js');
const tm = require('../../scripts/lib/opening-night-lane/trust-model.js');
const { evaluateBroadcastReadiness, isLaneAggregatorRow, BROADWAY_MIN } = require('../../scripts/lib/broadcast-readiness.js');
const { isScoreableSurvivor, hasValidScore } = require('../../scripts/verify-all-scored.js');
const { liveScoredCounts, MIN_SCORED_REVIEWS } = require('../../scripts/lib/critic-consensus-eligibility.js');
const { loadReviewTexts } = require('../../scripts/lib/critic-consensus-inputs.js');
const { evaluateScoreConfidence } = require('../../scripts/lib/score-confidence-gate.js');

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
const outlets = registry.outlets || registry;
const getOutletTier = (id) => (outlets[id] && outlets[id].tier) || 3; // same fallback as send-opening-night-broadcast.js

// Production-shaped ensemble result: what scoreReviewFile returns for a full-text review.
const SCORES = [82, 74, 66, 58, 88, 71];
function stubScorer() {
  let n = 0;
  return {
    scoreReviewFile: async (file) => {
      const score = SCORES[n++ % SCORES.length];
      const bucket = score >= 85 ? 'Rave' : score >= 70 ? 'Positive' : score >= 55 ? 'Mixed' : 'Negative';
      return {
        success: true,
        ensembleResult: { score },
        scoredFile: {
          ...file, assignedScore: score,
          llmScore: { score, confidence: 'high', bucket, thumb: score >= 70 ? 'Up' : 'Flat', keyPhrases: [] },
          llmMetadata: { model: 'ensemble:stub', promptVersion: 'stub' },
          ensembleData: { scoringMethod: 'ensemble', scoreDelta: 0 },
        },
      };
    },
  };
}

// Mirrors the rebuild's row for a lane file: the fields the gates read, with laneSource from the real helper.
function rebuiltRow(d, show) {
  const src = tm.laneRowSource(d, { openingDate: show.openingDate });
  return {
    showId: d.showId, outletId: d.outletId, outlet: d.outlet, assignedScore: d.assignedScore,
    dtliThumb: d.dtliThumb || null, bwwThumb: d.bwwThumb || null,
    ...(d.llmScore ? { scoreConfidence: d.llmScore.confidence || null } : {}),
    ...(d.scoreConfidence === 'low' ? { scoreConfidence: 'low' } : {}),
    ...(src ? { laneSource: src } : {}),
  };
}

let night$;
test.before(async () => {
  night$ = await night.replay({
    site: true,
    scoreText: inline.ensembleScoreText(stubScorer()),
    inspect: async ({ reviewTextsDir, show, live }) => {
      const dir = path.join(reviewTextsDir, show.id);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, p: path.join(dir, f), d: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
      return { show, files, liveRows: live.map((x) => x.row), consensusInputs: loadReviewTexts(show.id, null, { reviewTextsDir }) };
    },
  });
});

test('the replay is lane-only: every published row is a lane row with an inline ensemble score and no DTLI/BWW thumb', () => {
  const { liveRows, show } = night$.inspected;
  assert.ok(liveRows.length >= BROADWAY_MIN, `need ${BROADWAY_MIN}+ published rows, got ${liveRows.length}`);
  for (const r of liveRows) {
    assert.equal(tm.isLaneReview(r, { openingDate: show.openingDate }), true, `${r.outletId} is not a lane row`);
    assert.ok(Number.isFinite(r.assignedScore), `${r.outletId} unscored`);
    assert.ok(!r.dtliThumb && !r.bwwThumb, `${r.outletId} carries an aggregator thumb, so this is not a lane-only fixture`);
  }
  assert.ok(liveRows.some((r) => r.llmScore && r.ensembleData), 'no row carries the inline ensemble result');
});

test('readiness gate: the lane-only night is ready, both during the lease (raw rows) and after a rebuild', () => {
  const { liveRows, files, show } = night$.inspected;
  const lease = evaluateBroadcastReadiness(liveRows, show.category);
  assert.equal(lease.ready, true, lease.reason);
  assert.match(lease.reason, /lane-aggregator/);

  const rebuilt = files.map(({ d }) => rebuiltRow(d, show)).filter((r) => r.assignedScore != null);
  assert.ok(rebuilt.every((r) => !('openingNightLane' in r)), 'rebuilt rows drop the provenance block');
  assert.ok(rebuilt.some((r) => r.laneSource === 'aggregator'));
  const after = evaluateBroadcastReadiness(rebuilt, show.category);
  assert.equal(after.ready, true, after.reason);
});

test('readiness gate still blocks a Broadway night with no DTLI, BWW or lane aggregator row', () => {
  const { liveRows, show } = night$.inspected;
  const strip = (r) => { const o = { ...r }; delete o.openingNightLane; delete o.productionVerified; delete o.laneSource; return o; };
  const ordinary = evaluateBroadcastReadiness(liveRows.map(strip), show.category);
  assert.equal(ordinary.ready, false);
  assert.match(ordinary.reason, /aggregator/);
  // outlet-index rows alone are not aggregator coverage
  const outletIndexOnly = liveRows.map((r) => ({ ...r, openingNightLane: { ...r.openingNightLane, source: 'outlet-index' } }));
  assert.equal(evaluateBroadcastReadiness(outletIndexOnly, show.category).ready, false);
  // a revoked lane stamp is ordinary again, raw or rebuilt
  assert.equal(evaluateBroadcastReadiness(liveRows.map((r) => ({ ...r, laneRevoked: true })), show.category).ready, false);
  assert.equal(isLaneAggregatorRow({ assignedScore: 70, laneSource: 'aggregator', laneRevoked: true }), false);
  // a stamp copied onto another show fails isLaneReview
  assert.equal(evaluateBroadcastReadiness(liveRows.map((r) => ({ ...r, showId: 'some-other-show' })), show.category).ready, false);
});

test('orphan gate: every lane review file is a scoreable survivor with a valid score (0 orphans)', () => {
  const { files, show } = night$.inspected;
  assert.ok(files.length >= BROADWAY_MIN);
  const orphans = files.filter(({ d, p }) => isScoreableSurvivor(d, show, p).eligible && !hasValidScore(d, show));
  assert.deepEqual(orphans.map((x) => x.f), []);
  assert.ok(files.every(({ d, p }) => isScoreableSurvivor(d, show, p).eligible), 'a lane file was not counted as a survivor');
});

test('consensus gate: the night is eligible and its review texts load as consensus inputs', () => {
  const { liveRows, consensusInputs, show } = night$.inspected;
  const counts = liveScoredCounts({ reviews: liveRows });
  assert.ok((counts.get(show.id) || 0) >= MIN_SCORED_REVIEWS, `consensus count ${counts.get(show.id)}`);
  assert.ok(consensusInputs.length >= MIN_SCORED_REVIEWS, `only ${consensusInputs.length} consensus inputs loaded`);
  assert.ok(consensusInputs.every((x) => Number.isFinite(x.score)));
});

test('send-script confidence floors (T1/T2/high-confidence) pass on raw lease rows and on rebuilt lane rows', () => {
  const { files, liveRows, show } = night$.inspected;
  // Raw lane rows carry confidence only inside llmScore; the gate must read it there (hi-conf was 0/8 before).
  assert.ok(liveRows.every((r) => r.scoreConfidence == null));
  const lease = evaluateScoreConfidence({ showReviews: liveRows, category: show.category, getOutletTier });
  assert.equal(lease.ok, true, lease.reasons.join(', '));
  const rows = files.map(({ d }) => rebuiltRow(d, show)).filter((r) => r.assignedScore != null);
  const gate = evaluateScoreConfidence({ showReviews: rows, category: show.category, getOutletTier });
  assert.equal(gate.ok, true, gate.reasons.join(', '));
  // a top-level 'low' (paywall fallback) still wins over llmScore.confidence
  const low = liveRows.map((r) => ({ ...r, scoreConfidence: 'low' }));
  assert.equal(evaluateScoreConfidence({ showReviews: low, category: show.category, getOutletTier }).counts.highConfidence, 0);
});

test('paywall fallback lane rows (aggregator thumb or stars, no LLM score) pass the orphan and readiness checks', () => {
  const show = night$.inspected.show;
  const base = { showId: show.id, night: show.openingDate, source: 'aggregator', seenAt: `${show.openingDate}T23:30:00Z`, publishDate: show.openingDate, fullText: '' };
  const thumb = tm.buildLaneReview({ ...base, outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'A Critic', url: 'https://www.wsj.com/arts-culture/theater/x-review-1', aggregator: { thumb: 'Up' } });
  const stars = tm.buildLaneReview({ ...base, outletId: 'nypost', outlet: 'New York Post', criticName: 'B Critic', url: 'https://nypost.com/2026/10/29/entertainment/x-review/', aggregator: { stars: 4 } });
  for (const d of [thumb, stars]) {
    assert.ok(Number.isFinite(d.assignedScore), 'fallback produced no score');
    assert.equal(d.scoreConfidence, 'low');
    assert.equal(hasValidScore(d, show), true, `${d.scoreSource} rejected by the orphan gate`);
    assert.equal(isLaneAggregatorRow(rebuiltRow(d, show)), true);
  }
});

test('wiring: the rebuild stamps laneSource from laneRowSource, and the workflow and missed-broadcasts use the readiness gate', () => {
  const rebuild = fs.readFileSync(path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), 'utf8');
  assert.match(rebuild, /laneSource: src/);
  assert.match(rebuild, /laneRowSource\(data, \{ openingDate/);
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'opening-night-broadcast.yml'), 'utf8');
  assert.match(wf, /evaluateBroadcastReadiness\(/);
  const missed = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'missed-broadcasts.js'), 'utf8');
  assert.match(missed, /evaluateBroadcastReadiness\(/);
});
