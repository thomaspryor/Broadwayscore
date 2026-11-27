// RULE21 / BRO-8264: exercise the real writer and fetch callers, without network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
const { prefetchDiscoveredArticle, applyPrefetch } = require('../../scripts/lib/discovery-prefetch');
const { createInlineScoring, LaneAwaitingEvidenceError } = require('../../scripts/lib/opening-night-lane/inline-score');
const { selectScorableText } = require('../../scripts/lib/scorable-text');
const { isPaywalledText } = require('../../scripts/lib/paywall-detector');
const url = 'https://pagesonstages.com/subscriber-review/';
const body = 'The production begins with an assured performance and a beautifully staged confrontation. '.repeat(10);
const html = `<article><div class="entry-content"><p>${body}</p><div class="wp-block-jetpack-subscriber-view"><p>Log in or pay to keep reading.</p></div></div></article>`;
const input = { outletId: 'pages-on-stages', outlet: 'Pages on Stages', criticName: 'Mason Pilevsky', url, source: 'ingest-urls', fields: { fullText: body } };

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8264-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('canonical writer persists raw-wall evidence on create and unchanged-body merge', (t) => {
  for (const existing of [false, true]) {
    const dir = temp(t);
    const options = { reviewTextsDir: dir, knownShowIds: ['subscriber-test'] };
    if (existing) createOrMergeReviewFile('subscriber-test', input, options);
    const result = createOrMergeReviewFile('subscriber-test', { ...input, html }, options);
    assert.equal(result.action, existing ? 'updated' : 'new', JSON.stringify(result));
    const stored = JSON.parse(fs.readFileSync(result.filepath));
    assert.equal(stored.paywalled, true);
    assert.equal(isPaywalledText(stored), true);
    assert.equal(selectScorableText(stored), null);
    assert.equal('html' in stored, false, 'raw HTML stays out of the review fields');
  }
});

test('discovery prefetch carries wall evidence into the writer', async (t) => {
  const pre = await prefetchDiscoveredArticle(url, { outletId: 'pages-on-stages', fetchPageFn: async () => ({ content: html }) });
  const result = createOrMergeReviewFile('subscriber-prefetch', applyPrefetch(input, pre), {
    reviewTextsDir: temp(t), knownShowIds: ['subscriber-prefetch'],
  });
  assert.ok(result.filepath, JSON.stringify(result));
  const stored = JSON.parse(fs.readFileSync(result.filepath));
  assert.equal(isPaywalledText(stored), true);
});

test('inline lane stops at the explicit wall without retrying or scoring the teaser', async (t) => {
  let fetches = 0;
  let scores = 0;
  let aggregator = {};
  const sc = createInlineScoring({
    show: { id: 'subscriber-lane', title: 'Subscriber Test' }, night: '2026-11-23',
    ledgerDir: temp(t), now: () => Date.parse('2026-11-23T23:00:00Z'),
    fetchPage: async () => { fetches++; return { content: html }; },
    extractArticle: () => body,
    aggregatorFor: () => aggregator,
    scoreText: async () => { scores++; return { score: 70 }; },
  });
  await assert.rejects(sc.fetchReview({ url }), e => e instanceof LaneAwaitingEvidenceError && /subscriber-paywall/.test(e.message));
  await assert.rejects(sc.fetchReview({ url }), LaneAwaitingEvidenceError);
  assert.equal(fetches, 1);
  assert.equal(scores, 0);
  aggregator = { thumb: 'Up' };
  const fallback = await sc.fetchReview({ url });
  assert.equal(fallback.fullText, '');
  assert.equal(fallback.aggregator.thumb, 'Up');
  assert.equal(fetches, 1, 'later rating needs no second fetch');
  assert.equal(scores, 0);
});
