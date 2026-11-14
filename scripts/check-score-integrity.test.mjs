// BRO-2809: noStarOutletWithScore must be detected and fail the P0 gate (exit 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'check-score-integrity.js');
const { discardNoRatingOutletScore } = require('./lib/no-rating-outlet-score.js');

function run(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-integrity-'));
  const rt = path.join(dir, 'review-texts');
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.join(rt, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(rt, rel), JSON.stringify(data));
  }
  fs.mkdirSync(rt, { recursive: true });
  const out = path.join(dir, 'report.json');
  const r = spawnSync('node', [script], {
    encoding: 'utf8',
    env: { ...process.env, SCORE_INTEGRITY_REVIEW_TEXTS_DIR: rt, SCORE_INTEGRITY_OUTPUT_PATH: out },
  });
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { r, report };
}

const leaked = {
  outletId: 'london-theatre', originalScore: 100,
  source: 'show-score-playwright', scoreSource: 'llm-v6',
};

test('no-star outlet with originalScore is flagged and exits 1', () => {
  const { r, report } = run({ 'show-a/london-theatre--x.json': leaked });
  assert.equal(r.status, 1);
  assert.equal(report.issues.noStarOutletWithScore, 1);
});

test('cleared / wrongProduction / star-publishing outlets are not flagged', () => {
  const { r, report } = run({
    'show-a/london-theatre--cleared.json': { ...leaked, originalScore: null, originalScoreCleared: true },
    'show-a/london-theatre--wrong.json': { ...leaked, wrongProduction: true },
    'show-a/guardian--y.json': { outletId: 'guardian', originalScore: '4/5', scoreSource: 'outlet-embedded-data' },
  });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(report.issues.noStarOutletWithScore, 0);
});

test('display-name outletId is flagged by the gate too', () => {
  const { r, report } = run({ 'show-a/lt--x.json': { ...leaked, outletId: 'London Theatre' } });
  assert.equal(r.status, 1);
  assert.equal(report.issues.noStarOutletWithScore, 1);
});

test('discardNoRatingOutletScore clears the leak so the check passes', () => {
  const d = { ...leaked };
  assert.equal(discardNoRatingOutletScore(d), true);
  assert.equal(d.originalScore, null);
  assert.equal(d.previousOriginalScore, 100);
  assert.equal(d.originalScoreCleared, true);
  assert.equal(run({ 'show-a/london-theatre--x.json': d }).r.status, 0);
});

test('discardNoRatingOutletScore leaves star outlets and display-name outlets handled', () => {
  const g = { outletId: 'guardian', originalScore: '4/5' };
  assert.equal(discardNoRatingOutletScore(g), false);
  assert.equal(g.originalScore, '4/5');
  const d = { outletId: 'London Theatre', originalScore: '3/5 stars' };
  assert.equal(discardNoRatingOutletScore(d), true);
});

test('London Theatre anchor worklists include cleared and missing ratings', () => {
  const anchored = {
    outletId: 'london-theatre', scoreSource: 'anchored-v6',
    originalScore: '4/5 stars', originalScoreSource: 'londontheatre-page-json',
    llmScore: { score: 79, band: { floor: 71, ceiling: 90 } },
  };
  const { r, report } = run({
    'show-a/london-theatre--confirmed.json': anchored,
    'show-a/london-theatre--unknown.json': {
      ...anchored, originalScore: null, originalScoreCleared: true,
    },
    'show-a/london-theatre--mismatch.json': { ...anchored, originalScore: '2/5 stars' },
    'show-a/guardian--control.json': { ...anchored, outletId: 'guardian' },
  });
  assert.equal(r.status, 0, r.stdout);
  const audit = report.londonTheatreAnchors;
  assert.equal(audit.total, 3);
  assert.equal(audit.confirmed.length, 1);
  assert.equal(audit.ratingVerificationQueue.length, 1);
  assert.equal(audit.reanchorQueue.length, 1);
  assert.equal(audit.ratingVerificationQueue[0].file, 'show-a/london-theatre--unknown.json');
  assert.deepEqual(audit.reanchorQueue[0].criticBand, { floor: 31, ceiling: 50 });
  assert.equal(report.totalIssues, 0, 'anchor worklists are advisory, not new blocking gates');
});
