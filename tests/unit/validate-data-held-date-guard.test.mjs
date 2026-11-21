/**
 * BRO-5030: a review the date-guard flagger HELD for human review must not
 * fail validate-data.js CHECK 0 (which refused every validate-gated core-data
 * push site-wide, 4 times in the BRO-4884 backfill). An unheld dated-outside-
 * run file must still fail.
 *
 * The decision lives in scripts/lib/date-guard-hold.js and is require()d here,
 * never copied (CLAUDE.md §15). Wiring tests read the real sources to prove
 * validate-data.js and flag-wrong-production-by-date.js call it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MARKER_FIELD,
  applyDateGuardHold,
  holdMarkerNeedsWrite,
  clearDateGuardHold,
  rebuildExcludesHeld,
  classifyDateGuardBackstop,
} = require('../../scripts/lib/date-guard-hold.js');
const { evaluateCurrentRunCorroboration, shouldHoldDateGuardFlag } = require('../../scripts/lib/wrong-production-corroboration.js');
const { evaluateDatePlausibility } = require('../../scripts/lib/date-plausibility.js');
const { safeWriteReview } = require('../../scripts/lib/review-write-guard.js');

const ROOT = path.join(import.meta.dirname, '..', '..');

// Shape of the an-oak-tree-off-west-end-2026 case: a 2025 review on a show that
// starts 2026-10, archived by Theatre Record under an in-run month.
const SHOW = {
  id: 'an-oak-tree-off-west-end-2026',
  title: 'An Oak Tree',
  category: 'off-west-end',
  previewDate: '2026-10-01',
  openingDate: '2026-10-08',
  closingDate: '2026-11-15',
};

function review(extra = {}) {
  return {
    showId: SHOW.id,
    outletId: 'thestage',
    outlet: 'The Stage',
    criticName: 'Dave Fargnoli',
    publishDate: '2025-03-12',
    url: 'https://www.thestage.co.uk/reviews/an-oak-tree-review',
    theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/10/an-oak-tree/',
    ...extra,
  };
}

function heldReview(extra = {}) {
  const r = review(extra);
  const corrob = evaluateCurrentRunCorroboration({ review: r, show: SHOW });
  applyDateGuardHold(r, { signals: corrob.signals, issue: 'before_preview', diffDays: 568, now: new Date('2026-10-11T00:00:00Z') });
  return r;
}

describe('fixture sanity (the flagger would hold this file)', () => {
  test('dated far outside the run and implausible', () => {
    assert.equal(evaluateDatePlausibility({ review: review(), show: SHOW }).implausible, true);
  });
  test('Theatre Record month inside the run → shouldHoldDateGuardFlag', () => {
    const corrob = evaluateCurrentRunCorroboration({ review: review(), show: SHOW });
    assert.equal(shouldHoldDateGuardFlag({ corrob, implausible: true }), true);
  });
});

describe('classifyDateGuardBackstop (validate-data CHECK 0)', () => {
  test('held file → held (warning), not error', () => {
    assert.equal(classifyDateGuardBackstop({ review: heldReview(), show: SHOW }).kind, 'held');
  });

  test('unheld dated-outside-run file → still error', () => {
    assert.equal(classifyDateGuardBackstop({ review: review(), show: SHOW }).kind, 'error');
  });

  test('in-run date → ok', () => {
    assert.equal(classifyDateGuardBackstop({ review: review({ publishDate: '2026-10-09' }), show: SHOW }).kind, 'ok');
  });

  test('marker goes stale when publishDate changes → error again', () => {
    const r = heldReview();
    r.publishDate = '2024-01-02';
    assert.equal(classifyDateGuardBackstop({ review: r, show: SHOW }).kind, 'error');
  });

  test('marker does not cover a file the hold rule no longer holds (TR URL gone)', () => {
    const r = heldReview();
    delete r.theatreRecordUrl;
    assert.equal(classifyDateGuardBackstop({ review: r, show: SHOW }).kind, 'error');
  });

  test('a hand-typed marker on a file the flagger would not hold → error', () => {
    const r = review({ theatreRecordUrl: undefined });
    r[MARKER_FIELD] = { reason: 'x', signals: [], publishDate: r.publishDate, heldAt: '2026-10-11T00:00:00.000Z' };
    assert.equal(classifyDateGuardBackstop({ review: r, show: SHOW }).kind, 'error');
  });

  // Rebuild SCORES these despite the pre-window date, so a marker must not hide them.
  test('cv-affirms-production alongside the TR month (rebuild CV override, scored) → error', () => {
    const r = heldReview({ contentVerification: { isValid: true, confidence: 'high' } });
    assert.equal(rebuildExcludesHeld({ review: r, show: SHOW, corrob: evaluateCurrentRunCorroboration({ review: r, show: SHOW }) }), false);
    assert.equal(classifyDateGuardBackstop({ review: r, show: SHOW }).kind, 'error');
  });

  test('allowEarlyDate / routedFromShowId (rebuild skips its guard, scored) → error', () => {
    assert.equal(classifyDateGuardBackstop({ review: heldReview({ allowEarlyDate: true }), show: SHOW }).kind, 'error');
    assert.equal(classifyDateGuardBackstop({ review: heldReview({ routedFromShowId: 'x-2020' }), show: SHOW }).kind, 'error');
  });

  test('non-object marker is ignored', () => {
    const r = review();
    r[MARKER_FIELD] = true;
    assert.equal(classifyDateGuardBackstop({ review: r, show: SHOW }).kind, 'error');
  });
});

describe('flagger writes the marker', () => {
  test('applyDateGuardHold stamps reason, signals, publishDate, heldAt and safeWriteReview persists it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5030-'));
    try {
      const showDir = path.join(dir, SHOW.id);
      fs.mkdirSync(showDir);
      const fp = path.join(showDir, 'thestage--dave-fargnoli.json');
      fs.writeFileSync(fp, JSON.stringify(review(), null, 2));
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const corrob = evaluateCurrentRunCorroboration({ review: data, show: SHOW });
      assert.equal(holdMarkerNeedsWrite(data, corrob.signals), true);
      applyDateGuardHold(data, { signals: corrob.signals, issue: 'before_preview', diffDays: 568 });
      safeWriteReview(fp, data);
      const written = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const m = written[MARKER_FIELD];
      assert.ok(m && typeof m === 'object');
      assert.equal(m.publishDate, '2025-03-12');
      assert.deepEqual(m.signals, ['theatre-record-month:2026/10']);
      assert.match(m.reason, /theatre-record-month:2026\/10/);
      assert.ok(!Number.isNaN(Date.parse(m.heldAt)));
      assert.equal(written.wrongProduction, undefined, 'a hold never flags');
      assert.equal(classifyDateGuardBackstop({ review: written, show: SHOW }).kind, 'held');
      // Rerun with the same signals does not rewrite it.
      assert.equal(holdMarkerNeedsWrite(written, corrob.signals), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clearDateGuardHold clears the marker and the clear survives safeWriteReview merge', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5030-clear-'));
    try {
      const showDir = path.join(dir, SHOW.id);
      fs.mkdirSync(showDir);
      const fp = path.join(showDir, 'thestage--dave-fargnoli.json');
      fs.writeFileSync(fp, JSON.stringify(heldReview(), null, 2));
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      data.wrongProduction = true;
      assert.equal(clearDateGuardHold(data), true);
      safeWriteReview(fp, data);
      const written = JSON.parse(fs.readFileSync(fp, 'utf8'));
      assert.ok(!written[MARKER_FIELD], 'merge must not restore the cleared marker');
      assert.equal(written.wrongProduction, true);
      assert.equal(clearDateGuardHold(written), false);
      assert.equal(holdMarkerNeedsWrite(written, ['theatre-record-month:2026/10']), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wiring (real sources)', () => {
  const vd = fs.readFileSync(path.join(ROOT, 'scripts', 'validate-data.js'), 'utf8');
  const fl = fs.readFileSync(path.join(ROOT, 'scripts', 'flag-wrong-production-by-date.js'), 'utf8');

  test('validate-data CHECK 0 decides through classifyDateGuardBackstop and warns on held', () => {
    assert.match(vd, /require\('\.\/lib\/date-guard-hold'\)/);
    assert.match(vd, /classifyDateGuardBackstop\(\{ review: data, show: wfShow \}\)/);
    assert.match(vd, /kind === 'held'[\s\S]{0,200}warn\(`\[date-guard-held\]/);
    const heldBranch = vd.slice(vd.indexOf("kind === 'held'"), vd.indexOf("kind === 'error'"));
    assert.doesNotMatch(heldBranch, /\bcontinue;/, 'held files must still run CHECK 1+');
    assert.match(vd, /kind === 'error'[\s\S]{0,80}reviewFileError\(`\[wrong-production-by-date\]/);
  });

  test('flagger stamps the marker on its hold branch and clears it when it flags', () => {
    assert.match(fl, /require\('\.\/lib\/date-guard-hold'\)/);
    assert.match(fl, /shouldHoldDateGuardFlag\(\{ corrob, implausible \}\)[\s\S]{0,1200}applyDateGuardHold\(data,[\s\S]{0,200}safeWriteReview\(filePath, data\)/);
    assert.match(fl, /data\.wrongProduction = true;\s*\n\s*invalidateWrongProductionAutoClear\(data\);\s*\n\s*clearDateGuardHold\(data\);/);
    assert.match(fl, /rebuildExcludesHeld\(\{ review: data, show, corrob \}\) && holdMarkerNeedsWrite/);
  });
});
