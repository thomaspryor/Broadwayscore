// BRO-5201: the lane's review files carry firstSeenAt, the retrieval clock press-night-record's same-night gate reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLaneReviewWriter } = require('../../scripts/lib/opening-night-lane/persist');
const trust = require('../../scripts/lib/opening-night-lane/trust-model');
const { readReviewFileState } = require('../../scripts/lib/press-night-review-state');

const SHOW = { id: 'lane-persist-2026', title: 'Lane Persist', openingDate: '2026-10-29', market: 'broadway' };
const NIGHT = '2026-10-29';
const laneRow = (seenAt) => Object.assign(trust.buildLaneReview({
  showId: SHOW.id, night: NIGHT, source: 'aggregator', seenAt, outletId: 'nytimes', outlet: 'The New York Times',
  criticName: 'Ada Critic', url: 'https://www.nytimes.com/2026/10/29/theater/lane-persist-review.html', publishDate: NIGHT,
  fullText: 'word '.repeat(2000), aggregator: {},
}), { assignedScore: 72 });

test('lane writer stamps firstSeenAt from the pass that saw the review, once, and the same-night gate reads it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-persist-'));
  try {
    const write = createLaneReviewWriter({ reviewTextsDir: root, show: SHOW, night: NIGHT });
    const first = write(laneRow('2026-10-30T03:05:00.000Z'));
    assert.equal(first.row.firstSeenAt, '2026-10-30T03:05:00.000Z');
    // A later rewrite of the same review (a rescore) never moves the clock.
    const again = write(laneRow('2026-10-30T04:40:00.000Z'));
    assert.equal(again.file, first.file);
    assert.equal(again.row.firstSeenAt, '2026-10-30T03:05:00.000Z');
    const state = readReviewFileState(SHOW.id, SHOW, { dir: root });
    assert.equal(state.available, true);
    assert.equal(state.files.length, 1);
    assert.equal(state.files[0].firstSeenAt, '2026-10-30T03:05:00.000Z');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
