/**
 * Integration test for scripts/audit-star-score-mismatch.js (BRO-434).
 *
 * BRO-434 was card #396's bug recurring: a review whose explicit critic
 * rating was mis-extracted (wrong show's star grabbed off a combined
 * multi-show review column, or a scraper artifact like a photo-gallery
 * pager misread as a star count) silently overrides a correct LLM read.
 * Root cause found this time: scripts/recover-explicit-ratings.js's
 * "missing originalScore" candidacy filter treated an INTENTIONALLY
 * CLEARED rating (originalScore: null + originalScoreCleared: true) as
 * "missing" and re-extracted the same wrong value on its next run,
 * regressing 2 of card #396's original 10 fixes (confirmed live on
 * take-me-out-2022 and for-colored-girls...-2022, both Theater Life/
 * David Sheward). Fixed via scripts/lib/star-score-mismatch.js's
 * isIntentionallyClearedRating(), which recover-explicit-ratings.js now
 * checks before treating a review as a recovery candidate.
 *
 * Runs the real CLI as a subprocess against a fixture review-texts dir so
 * the test exercises the actual baseline read/write + exit-code contract,
 * not a re-implementation of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isIntentionallyClearedRating } = require('./lib/star-score-mismatch.js');

const SCRIPT = path.join(import.meta.dirname, 'audit-star-score-mismatch.js');

function writeReview(reviewTextsDir, showId, file, data) {
  const dir = path.join(reviewTextsDir, showId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + '\n');
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-star-score-mismatch-'));
  const reviewTextsDir = path.join(tmp, 'review-texts');
  const baselinePath = path.join(tmp, 'baseline.json');

  // The Theater Life / card #396 shape: wp-api-title grabbed the wrong
  // show's star off a combined multi-show roundup column. LLM read (93,
  // Rave) is the independently-correct one; the 2/5 star belongs to the
  // OTHER show in the same article.
  writeReview(reviewTextsDir, 'fixture-mis-extracted-2026', 'theater-life--critic.json', {
    outlet: 'Theater Life',
    originalScore: '2/5 stars',
    originalScoreNormalized: 40,
    scoreSource: 'wp-api-title',
    assignedScore: 40,
    llmScore: { score: 93, confidence: 'medium' },
  });

  // A consistent review — star and LLM agree — must never flag.
  writeReview(reviewTextsDir, 'fixture-consistent-2026', 'outlet--critic.json', {
    outlet: 'Some Outlet',
    originalScore: '5/5 stars',
    originalScoreNormalized: 100,
    scoreSource: 'star-icon',
    assignedScore: 95,
    llmScore: { score: 96, confidence: 'high' },
  });

  // A review whose rating was INTENTIONALLY cleared (the card #396 /
  // BRO-434 fix pattern): originalScore is null, but the breadcrumb proves
  // it was deliberate, not missing. Must never flag regardless of how far
  // the LLM/assigned scores drifted from the (discarded) prior rating.
  writeReview(reviewTextsDir, 'fixture-cleared-2026', 'theater-life--critic.json', {
    outlet: 'Theater Life',
    originalScore: null,
    originalScoreCleared: true,
    originalScoreClearedReason: 'card-396: wp-api-title grabbed wrong show star off Theater Life combined multi-show column',
    scoreSource: 'llm-v6',
    assignedScore: 85,
    llmScore: { score: 84, confidence: 'medium' },
  });

  return { tmp, reviewTextsDir, baselinePath };
}

function runAudit({ reviewTextsDir, baselinePath }, args = []) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, REVIEW_TEXTS_DIR: reviewTextsDir, STAR_MISMATCH_BASELINE: baselinePath },
      encoding: 'utf8',
    });
    return { out, status: 0 };
  } catch (err) {
    return { out: (err.stdout || '') + (err.stderr || ''), status: err.status };
  }
}

test('flags a mis-extracted star as a NEW mismatch and exits 1', () => {
  const fixture = makeFixture();
  try {
    const { out, status } = runAudit(fixture);
    assert.equal(status, 1);
    assert.match(out, /1 flagged/);
    assert.match(out, /fixture-mis-extracted-2026/);
    assert.doesNotMatch(out, /fixture-consistent-2026/);
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('an intentionally-cleared rating (card #396/BRO-434 fix shape) never flags, even with a wide LLM/assigned gap', () => {
  const fixture = makeFixture();
  try {
    const { out } = runAudit(fixture, ['--json']);
    const parsed = JSON.parse(out);
    const showIds = parsed.findings.map(f => f.showId);
    assert.ok(!showIds.includes('fixture-cleared-2026'), 'cleared review must not appear in findings');
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('--write-baseline acks the finding, then a normal run reports 0 new and exits 0', () => {
  const fixture = makeFixture();
  try {
    const written = runAudit(fixture, ['--write-baseline']);
    assert.equal(written.status, 0);
    assert.match(written.out, /Wrote baseline: 1 known mismatch/);

    const baseline = JSON.parse(fs.readFileSync(fixture.baselinePath, 'utf8'));
    assert.deepEqual(baseline.keys, ['fixture-mis-extracted-2026/theater-life--critic.json#2/5 stars']);

    const { out, status } = runAudit(fixture);
    assert.equal(status, 0);
    assert.match(out, /0 flagged/);
    assert.match(out, /1 baselined/);
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('a DIFFERENT bad rating in the same file re-alerts even after baselining the old one (keyOf includes originalRating)', () => {
  const fixture = makeFixture();
  try {
    runAudit(fixture, ['--write-baseline']);

    // Simulate the star getting re-extracted to a different (still wrong)
    // value — the exact BRO-434 regression shape, minus the intentional-clear
    // breadcrumb. The baseline must not silently swallow it.
    writeReview(fixture.reviewTextsDir, 'fixture-mis-extracted-2026', 'theater-life--critic.json', {
      outlet: 'Theater Life',
      originalScore: '1/5 stars',
      originalScoreNormalized: 20,
      scoreSource: 'wp-api-title',
      assignedScore: 20,
      llmScore: { score: 93, confidence: 'medium' },
    });

    const { out, status } = runAudit(fixture);
    assert.equal(status, 1);
    assert.match(out, /1 flagged/);
    assert.match(out, /fixture-mis-extracted-2026/);
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

// --- Unit coverage for the predicate that fixes the BRO-434 regression ---
// (scripts/recover-explicit-ratings.js's candidacy filter calls this exact
// function; see the file header for the root-cause story.)

test('isIntentionallyClearedRating: true only when originalScoreCleared === true', () => {
  assert.equal(isIntentionallyClearedRating({ originalScoreCleared: true }), true);
  assert.equal(isIntentionallyClearedRating({ originalScoreCleared: false }), false);
  assert.equal(isIntentionallyClearedRating({}), false);
  assert.equal(isIntentionallyClearedRating(null), false);
  assert.equal(isIntentionallyClearedRating({ originalScoreCleared: 'true' }), false, 'must be the boolean, not a truthy string');
});
