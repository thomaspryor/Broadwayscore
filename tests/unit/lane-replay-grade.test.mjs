// BRO-5201 S4-T6: lane-replay-grade grades a replayed night the way press-night-record grades a real one. A synthetic
// two-review night through the real module: on time is PASS, a census review live after +2h fails same-night
// completeness, a lane publish error fails it even when everything is live, and a source error alone does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const grade = require('../../scripts/lib/lane-replay-grade.js');
const pnr = require('../../scripts/lib/press-night-record.js');
const ledger = require('../../scripts/lib/opening-night-lane/ledger.js');

const MIN = 60 * 1000;
const SHOW = { id: 'grade-test-2026', title: 'Grade Test', openingDate: '2026-11-08', category: 'broadway' };
const NIGHT = '2026-11-08';
const EMB = Date.parse(pnr.defaultEmbargoAt(SHOW));
const ROWS = [
  { url: 'https://www.nytimes.com/2026/11/08/theater/grade-test-review.html', outletId: 'nytimes', outlet: 'The New York Times', criticName: 'A Critic', tier: 1, publishDate: NIGHT },
  { url: 'https://variety.com/2026/legit/reviews/grade-test-review-1/', outletId: 'variety', outlet: 'Variety', criticName: 'B Critic', tier: 1, publishDate: NIGHT },
];

/** Publish each row at its own minute after embargo through the modelled site, then grade the night. */
async function night(liveAfterMin, run = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-grade-'));
  try {
    let clock = EMB - 10 * MIN;
    const site = grade.createReplaySitePorts({ now: () => clock });
    const ledgerDir = path.join(dir, 'ledger');
    const reviewTextsDir = path.join(dir, 'review-texts');
    fs.mkdirSync(reviewTextsDir);
    ledger.appendEvent(ledgerDir, { show: SHOW.id, night: NIGHT, reviewKey: ROWS[0].url, stage: 'discovered', at: new Date(EMB + MIN).toISOString() });
    for (const [i, row] of ROWS.entries()) {
      clock = EMB + liveAfterMin[i] * MIN;
      await site.updateReviews((doc) => ({ doc: { reviews: [...doc.reviews, row] }, added: 1, applied: [row] }));
      await site.deploy();
    }
    const rec = grade.replayToPressNightRecord({
      show: SHOW, night: NIGHT, live: site.live(), ledgerDir, reviewTextsDir, censusOutletIds: ['nytimes', 'variety'],
      startedAt: EMB - 10 * MIN, closedAt: EMB + 4 * 60 * MIN,
    });
    return grade.gradeReplay(rec, { errors: [], failed: [], unpublished: [], ...run });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('both reviews live within minutes of the embargo: same-night completeness PASS, no problems', async () => {
  const g = await night([5, 12]);
  assert.equal(g.sameNight.status, 'pass', g.sameNight.detail);
  assert.deepEqual(g.runProblems, []);
  assert.deepEqual(g.sourceErrors, []);
});

test('a census review live only after +2h fails same-night completeness and names the outlet', async () => {
  const g = await night([5, 150]);
  assert.equal(g.sameNight.status, 'fail');
  assert.match(g.sameNight.detail, /variety/);
  assert.equal(g.verdict, 'FAIL');
});

test('a lane publish error fails the night even when every review went live', async () => {
  const g = await night([5, 12], { errors: [{ adapter: 'publish', error: 'push rejected' }] });
  assert.equal(g.sameNight.status, 'fail');
  assert.deepEqual(g.runProblems, ['publish error: push rejected']);
  assert.match(g.sameNight.detail, /the lane run reported problems/);
});

test('a review that failed for good, or was scored and left unpublished, is a lane problem', async () => {
  const g = await night([5, 12], { failed: [{ key: 'k1', reason: 'fetch-failed' }], unpublished: [{ key: 'k2' }] });
  assert.equal(g.sameNight.status, 'fail');
  assert.deepEqual(g.runProblems, ['review failed: k1 (fetch-failed)', 'scored but unpublished: k2']);
});

test('a source page that errored is reported but is not a lane failure on its own', async () => {
  const err = { adapter: 'show-score', error: 'HTTP 404' };
  const g = await night([5, 12], { errors: [err] });
  assert.equal(g.sameNight.status, 'pass', g.sameNight.detail);
  assert.deepEqual(g.runProblems, []);
  assert.deepEqual(g.sourceErrors, [err]);
});
