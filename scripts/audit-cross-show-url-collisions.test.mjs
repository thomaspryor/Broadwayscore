/**
 * Integration test for scripts/audit-cross-show-url-collisions.js (BRO-810).
 *
 * Runs the real CLI as a subprocess against a fixture review-texts dir that
 * reproduces the two collision shapes found and fixed during the BRO-810
 * audit (144 -> 3 non-aggregator cross-show URL dupes, Aug 2026):
 *
 *   1. showId/directory mismatch — a file's own `showId` field points at a
 *      different production than the directory it lives in (old-times-1971/
 *      amny--matt-windman.json actually carried showId "old-times-2015").
 *      The pre-pass flags these as wrongProduction regardless of --apply.
 *   2. A genuine cross-show URL collision between two productions with no
 *      wrongProduction/wrongShow flag yet, where one candidate's publishDate
 *      lands within 60 days of its own show's opening and the other doesn't
 *      — high confidence, --apply should flag the other as wrongShow.
 *   3. A collision where one side already carries a human
 *      wrongProductionManualClear breadcrumb (the giant-royal-court-off-
 *      west-end-2024 / giant-west-end-2025 transfer pair) — --apply must
 *      leave it alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SCRIPT = path.join(import.meta.dirname, 'audit-cross-show-url-collisions.js');

function writeReview(reviewTextsDir, showId, file, data) {
  const dir = path.join(reviewTextsDir, showId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + '\n');
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cross-show-url-collisions-'));
  const reviewTextsDir = path.join(tmp, 'review-texts');
  const showsPath = path.join(tmp, 'fixture-shows.json');
  const reportPath = path.join(tmp, 'url-collision-report.json');

  fs.writeFileSync(showsPath, JSON.stringify({
    shows: [
      { id: 'fixture-old-2000', title: 'Fixture Old', category: 'broadway', openingDate: '2000-01-01' },
      { id: 'fixture-old-2020', title: 'Fixture Old', category: 'broadway', openingDate: '2020-03-01' },
      { id: 'fixture-collision-a-2024', title: 'Fixture Collision A', category: 'broadway', openingDate: '2024-06-01' },
      { id: 'fixture-collision-b-2024', title: 'Fixture Collision B', category: 'broadway', openingDate: '2024-09-01' },
      { id: 'fixture-transfer-owe-2024', title: 'Fixture Transfer', category: 'off-west-end', openingDate: '2024-05-01' },
      { id: 'fixture-transfer-we-2025', title: 'Fixture Transfer', category: 'west-end', openingDate: '2025-04-01' },
    ],
  }));

  // Case 1: showId/directory mismatch. File lives in fixture-old-2000/ but its
  // own showId says fixture-old-2020 — the pre-pass should flag this even
  // without --apply changing anything else.
  writeReview(reviewTextsDir, 'fixture-old-2000', 'outlet--critic.json', {
    showId: 'fixture-old-2020',
    outletId: 'outlet',
    criticName: 'Critic',
    url: 'https://example.com/fixture-old-review',
    fullText: 'A review of the 2020 revival.',
  });

  // Case 2: genuine cross-show URL collision, high confidence by date proximity.
  const sharedUrl = 'https://example.com/fixture-collision-review';
  writeReview(reviewTextsDir, 'fixture-collision-a-2024', 'outlet--critic.json', {
    showId: 'fixture-collision-a-2024',
    outletId: 'outlet',
    criticName: 'Critic',
    url: sharedUrl,
    publishDate: '2024-06-02',
    assignedScore: 70,
    fullText: 'A'.repeat(150),
  });
  writeReview(reviewTextsDir, 'fixture-collision-b-2024', 'outlet--critic.json', {
    showId: 'fixture-collision-b-2024',
    outletId: 'outlet',
    criticName: 'Critic',
    url: sharedUrl,
    publishDate: '2024-06-02',
    fullText: 'B'.repeat(150),
  });

  // Case 3: transfer pair, one side already human-cleared. --apply must not
  // add a new flag to either file.
  const transferUrl = 'https://example.co.uk/fixture-transfer-review';
  writeReview(reviewTextsDir, 'fixture-transfer-owe-2024', 'ukoutlet--critic.json', {
    showId: 'fixture-transfer-owe-2024',
    outletId: 'ukoutlet',
    criticName: 'Critic',
    url: transferUrl,
    publishDate: '2024-05-02',
    assignedScore: 80,
    fullText: 'C'.repeat(150),
    wrongProduction: false,
    wrongProductionManualClear: true,
    humanReviewedWrongProductionReason: 'Manual clear (fixture): correct production dir.',
  });
  writeReview(reviewTextsDir, 'fixture-transfer-we-2025', 'ukoutlet--critic.json', {
    showId: 'fixture-transfer-we-2025',
    outletId: 'ukoutlet',
    criticName: 'Critic',
    url: transferUrl,
    publishDate: '2025-04-02',
    assignedScore: 85,
    fullText: 'D'.repeat(150),
  });

  return { tmp, reviewTextsDir, showsPath, reportPath };
}

function runAudit({ reviewTextsDir, showsPath, reportPath }, args = []) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    env: {
      ...process.env,
      REVIEW_TEXTS_DIR: reviewTextsDir,
      SHOWS_PATH: showsPath,
      REPORT_PATH: reportPath,
    },
    encoding: 'utf8',
  });
}

function readReview(reviewTextsDir, showId, file) {
  return JSON.parse(fs.readFileSync(path.join(reviewTextsDir, showId, file), 'utf8'));
}

test('report-only run detects the showId mismatch, the collision, and the manually-cleared pair without writing any flags', () => {
  const fixture = makeFixture();
  try {
    const out = runAudit(fixture);
    assert.match(out, /ShowId mismatches: 1 flagged/);
    assert.match(out, /Cross-show collisions: 2/);

    const report = JSON.parse(fs.readFileSync(fixture.reportPath, 'utf8'));
    assert.equal(report.summary.total, 2);

    // No file should have been mutated in report-only mode.
    const mismatch = readReview(fixture.reviewTextsDir, 'fixture-old-2000', 'outlet--critic.json');
    assert.equal(mismatch.wrongProduction, undefined);
    const a = readReview(fixture.reviewTextsDir, 'fixture-collision-a-2024', 'outlet--critic.json');
    assert.equal(a.wrongShow, undefined);
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('--apply flags the showId mismatch and the losing collision candidate, and leaves the manually-cleared transfer pair untouched', () => {
  const fixture = makeFixture();
  try {
    runAudit(fixture, ['--apply']);

    // Case 1: showId/directory mismatch always gets flagged, --apply or not.
    const mismatch = readReview(fixture.reviewTextsDir, 'fixture-old-2000', 'outlet--critic.json');
    assert.equal(mismatch.wrongProduction, true);
    assert.match(mismatch.wrongProductionNote, /doesn't match directory/);

    // Case 2: fixture-collision-a-2024's publishDate is 1 day from its own
    // opening and >60d from fixture-collision-b-2024's — high confidence,
    // b's file (the loser) gets flagged wrongShow, a's does not.
    const winner = readReview(fixture.reviewTextsDir, 'fixture-collision-a-2024', 'outlet--critic.json');
    assert.equal(winner.wrongShow, undefined);
    const loser = readReview(fixture.reviewTextsDir, 'fixture-collision-b-2024', 'outlet--critic.json');
    assert.equal(loser.wrongShow, true);

    // Case 3: the transfer pair is untouched — the OWE side's manual-clear
    // breadcrumb must survive, and neither side gains a new flag.
    const owe = readReview(fixture.reviewTextsDir, 'fixture-transfer-owe-2024', 'ukoutlet--critic.json');
    assert.equal(owe.wrongProductionManualClear, true);
    assert.equal(owe.wrongProduction, false);
    const we = readReview(fixture.reviewTextsDir, 'fixture-transfer-we-2025', 'ukoutlet--critic.json');
    assert.equal(we.wrongShow, undefined);
    assert.equal(we.wrongProduction, undefined);
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});
