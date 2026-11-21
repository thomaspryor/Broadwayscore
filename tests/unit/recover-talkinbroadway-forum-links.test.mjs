// Regression test for BRO-3788: 20 more talkinbroadway review-texts files
// stuck the same way benevolent-off-broadway-2026 was under BRO-2605 — the
// stored url is the allthatchat_new/d.php forum ANNOUNCEMENT thread, which
// only ever holds a short teaser + a "Link" anchor to the real review page,
// never the review itself. This asserts the real parsing helpers (not a
// copy) correctly follow that link and pull the critic byline from live-
// shaped HTML fixtures (captured from a real talkinbroadway.com forum
// thread + review page during this fix), and that the real gap classifier
// treats the before/after fixtures the same way BRO-2605's test did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isForumThreadUrl,
  extractReviewPageUrl,
  extractCriticName,
} = require('../../scripts/lib/talkinbroadway-forum-link.js');
const { classifySilentGap } = require('../../scripts/lib/t1-silent-gap.js');

// Trimmed excerpt of a real allthatchat_new/d.php forum thread row (fetched
// live from talkinbroadway.com/allthatchat_new/d.php?id=2649682, BRO-3788).
const FORUM_THREAD_HTML = `
  <tr>
    <td class="message"><b>Link </b></td>
    <td class="message"><a target="_blank" href="https://www.talkinbroadway.com/page/ob/06_24_26.html">"CAMPING" Review</a></td>
  </tr>
`;

// Trimmed excerpt of the real review page the thread above links to
// (talkinbroadway.com/page/ob/06_24_26.html, fetched live, BRO-3788).
const REVIEW_PAGE_HTML = `
  Theatre Review by <a href="mailto:mdale@talkinbroadway.com">Michael Dale</a> - June 24, 2026</center>
`;

test('BRO-3788: isForumThreadUrl recognizes the dead-end allthatchat URL shape', () => {
  assert.equal(isForumThreadUrl('https://www.talkinbroadway.com/allthatchat_new/d.php?id=2649682'), true);
  assert.equal(isForumThreadUrl('https://www.talkinbroadway.com/page/ob/06_24_26.html'), false);
  assert.equal(isForumThreadUrl(null), false);
});

test('BRO-3788: extractReviewPageUrl follows the "Link" anchor to the real review page', () => {
  assert.equal(extractReviewPageUrl(FORUM_THREAD_HTML), 'https://www.talkinbroadway.com/page/ob/06_24_26.html');
});

test('BRO-3788: extractReviewPageUrl returns null when the thread has no Link row', () => {
  assert.equal(extractReviewPageUrl('<html><body>no link here</body></html>'), null);
  assert.equal(extractReviewPageUrl(null), null);
});

test('BRO-3788: extractCriticName pulls the byline from the review page (mailto-wrapped name)', () => {
  assert.equal(extractCriticName(REVIEW_PAGE_HTML), 'Michael Dale');
});

test('BRO-3788: extractCriticName returns null when no byline marker is present', () => {
  assert.equal(extractCriticName('<html><body>no byline here</body></html>'), null);
});

test('BRO-3788: extractCriticName handles a hyphenated critic name', () => {
  const html = 'Theatre Review by <a href="mailto:x">Anne-Marie Duff</a> - June 24, 2026</center>';
  assert.equal(extractCriticName(html), 'Anne-Marie Duff');
});

const classify = (file, over = {}) =>
  classifySilentGap({ file, show: {}, tier: 2, outletScored: false, now: new Date('2026-09-18T15:00:00.000Z'), ...over });

// Shape of e.g. camping-off-broadway-2026/talkinbroadway--unknown.json
// before the fix: stuck on the forum thread URL, permanently rejected.
const stuckOnForumThreadUrl = {
  url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2649682',
  contentTier: 'truncated',
  fullText: 'y'.repeat(400),
  textFetchedAt: '2026-09-02T16:34:11.295Z',
  rejectedAt: '2026-09-15T16:49:36.228Z',
  rejectedBy: 'ensemble-scoreability-check',
  rejectionReason: 'garbage_text',
};

// Shape after recover-talkinbroadway-forum-links.js re-ingests from the
// resolved review-page URL.
const recoveredFromReviewPageUrl = {
  url: 'https://www.talkinbroadway.com/page/ob/06_24_26.html',
  contentTier: 'complete',
  fullText: 'y'.repeat(3992),
  textFetchedAt: '2026-09-18T15:11:20.000Z',
};

test('BRO-3788: the original forum-thread fixture is classified as a permanently stuck gap', () => {
  assert.deepEqual(classify(stuckOnForumThreadUrl), { type: 'rejected-unscoreable', recoverable: false });
});

test('BRO-3788: the recovered review-page fixture is no longer a gap right after ingest (fresh text, unscored grace window)', () => {
  assert.equal(classify(recoveredFromReviewPageUrl), null);
});
