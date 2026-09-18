// Regression test for BRO-2605: benevolent-off-broadway-2026's Talkin'
// Broadway review sat rejected-unscoreable for >24h. Root cause: the stored
// URL was the allthatchat forum announcement thread, which only ever carries
// a short teaser + a "Link" to the real review page
// (talkinbroadway.com/page/ob/08_27_26.html) — no re-fetch of the forum
// thread URL could ever recover full review text, so the self-heal refetch
// and the >24h backstop both failed to resolve it. Fix: re-ingested from the
// linked review page (talkinbroadway--michael-dale.json), which pulled the
// complete review body. This asserts the real classifier (not a copy) treats
// the original stuck fixture as a gap and the recovered fixture as healed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifySilentGap } = require('../../scripts/lib/t1-silent-gap.js');

const classify = (file, over = {}) =>
  classifySilentGap({ file, show: {}, tier: 2, outletScored: false, now: new Date('2026-09-18T14:43:16.080Z'), ...over });

// Shape of data/review-texts/benevolent-off-broadway-2026/talkinbroadway--unknown.json
// before the fix: re-ingesting its own URL (the allthatchat forum thread) only
// ever returns a teaser, so the ensemble scoreability check correctly rejected
// it as garbage_text every time — a permanently stuck state, not a transient one.
const stuckOnForumThreadUrl = {
  url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2652669',
  contentTier: 'truncated',
  fullText: 'Michael Dale takes a look at benevolent from Good Apples Collective: '
    + "There is nothing so wrong with Broadway theatre that can't be improved by putting a few plays by Sophie McIntosh on the boards.",
  textFetchedAt: '2026-09-02T16:34:11.295Z',
  rejectedAt: '2026-09-15T15:09:09.908Z',
  rejectedBy: 'ensemble-scoreability-check',
  rejectionReason: 'garbage_text',
};

// Shape of the replacement data/review-texts/benevolent-off-broadway-2026/
// talkinbroadway--michael-dale.json written by ingest-review-from-url.js
// against the correct review-page URL: full body, no rejection.
const recoveredFromReviewPageUrl = {
  url: 'https://www.talkinbroadway.com/page/ob/08_27_26.html',
  contentTier: 'complete',
  fullText: 'y'.repeat(5270),
  textFetchedAt: '2026-09-18T14:43:07.360Z',
};

test('BRO-2605: the original forum-thread fixture is classified as a permanently stuck gap', () => {
  assert.deepEqual(classify(stuckOnForumThreadUrl), { type: 'rejected-unscoreable', recoverable: false });
});

test('BRO-2605: the recovered review-page fixture is no longer a gap right after ingest (fresh text, unscored grace window)', () => {
  assert.equal(classify(recoveredFromReviewPageUrl), null);
});

test('BRO-2605: even once the scoring grace window elapses, the recovered fixture is dispatchable — never rejected-unscoreable again', () => {
  const result = classify(recoveredFromReviewPageUrl, { now: new Date('2026-09-19T03:00:00.000Z') });
  assert.equal(result.type, 'unscored');
  assert.equal(result.recoverable, false);
  assert.equal(result.dispatchable, true);
});
