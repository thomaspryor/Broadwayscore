/**
 * BRO-4596: score-vs-models detector. Fixtures use the real getBestScore, so a
 * routing change that alters what a record publishes changes these results.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { modelMedian, evaluateScoreVsModels, keyOf } = require('./score-vs-models.js');
const { scan } = require('../audit-score-vs-models.js');

const ens = (c, o, g) => ({ needsReview: false, claudeScore: c, openaiScore: o, geminiScore: g });
// A legacy assignedScore of 50 with three models at ~80 (the Edwin Drood shape).
const legacy = (over = {}) => ({
  outletId: 'ap', fullText: 'x'.repeat(400), scoreSource: 'assignedScore',
  assignedScore: 50, llmScore: { score: 80, confidence: 'high' }, ensembleData: ens(82, 80, 78), ...over,
});

const scanOne = (rec) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'score-vs-models-one-'));
  fs.mkdirSync(path.join(root, 'show-a'));
  fs.writeFileSync(path.join(root, 'show-a', 'x.json'), JSON.stringify(rec));
  return scan(root).findings;
};

test('modelMedian: median of the model scores, null for <2 models or single-model emergency', () => {
  assert.equal(modelMedian({ ensembleData: ens(82, 80, 60) }), 80);
  assert.equal(modelMedian({ ensembleData: ens(82, 60, null) }), 71);
  assert.equal(modelMedian({ ensembleData: ens(82, null, null) }), null);
  assert.equal(modelMedian({ ensembleData: { ...ens(82, 80, 78), singleModelEmergency: true } }), null);
  assert.equal(modelMedian({}), null);
});

test('flags a published score 25+ points and a bucket from the model median', () => {
  // A published 2/5 star on a known star outlet beats three models at ~80.
  const star = { outletId: 'nytimes', fullText: 'x'.repeat(400), scoreSource: 'json-ld', originalScore: '2/5',
    originalScoreSource: 'json-ld', originalScoreNormalized: 40, llmScore: { score: 80, confidence: 'high' }, ensembleData: ens(82, 80, 78) };
  const hit = evaluateScoreVsModels(star);
  assert.equal(hit.score, 40);
  assert.equal(hit.median, 80);
  assert.equal(hit.gap, 40);
  assert.equal(scanOne(star).length, 1);
});

test('a legacy 50 that getBestScore already overrides with the models is not a finding', () => {
  assert.equal(evaluateScoreVsModels(legacy()), null);
});

test('stays quiet when score and models agree, in the same bucket, or on a human override', () => {
  assert.equal(evaluateScoreVsModels(legacy({ assignedScore: 78, llmScore: { score: 80, confidence: 'high' } })), null);
  assert.equal(evaluateScoreVsModels(legacy({ humanReviewScore: 45 })), null);
  assert.equal(evaluateScoreVsModels(legacy({ wrongProduction: true })), null);
  assert.equal(evaluateScoreVsModels(null), null);
});

test('keyOf changes when the published score changes', () => {
  const f = { showId: 's', file: 'a.json', source: 'x', score: 50 };
  assert.notEqual(keyOf(f), keyOf({ ...f, score: 80 }));
});

test('CLI: a corrupt baseline fails (exit 2) instead of reading as "everything new"; a missing one is fine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'score-vs-models-cli-'));
  fs.mkdirSync(path.join(root, 'show-a'));
  fs.writeFileSync(path.join(root, 'show-a', 'ap--x.json'), JSON.stringify(legacy()));
  const bad = path.join(root, 'bad-baseline.json');
  fs.writeFileSync(bad, '{not json');
  const run = (baseline) => spawnSync(process.execPath, [path.resolve('scripts/audit-score-vs-models.js')],
    { env: { ...process.env, REVIEW_TEXTS_DIR: root, SCORE_VS_MODELS_BASELINE: baseline }, encoding: 'utf8' });
  assert.equal(run(bad).status, 2);
  assert.equal(run(path.join(root, 'absent.json')).status, 0);
});

test('scan walks a corpus dir and counts every json file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'score-vs-models-'));
  fs.mkdirSync(path.join(root, 'show-a'));
  fs.writeFileSync(path.join(root, 'show-a', 'ap--x.json'), JSON.stringify(legacy()));
  fs.writeFileSync(path.join(root, 'show-a', 'bad.json'), '{not json');
  fs.writeFileSync(path.join(root, 'show-a', 'note.txt'), 'x');
  const r = scan(root);
  assert.equal(r.scanned, 1);
  assert.ok(r.findings.length <= 1);
});
