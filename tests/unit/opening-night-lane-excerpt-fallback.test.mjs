// BRO-6066: on 2026-10-22 the lane lost the WSJ review for good: its page was a paywall teaser, the scorer's input gate
// refused it (input_validation_failed:body_too_short), and the aggregator fallback never ran because nothing passed the
// aggregator's data to the scorer (aggregatorFor was not wired in the real lane). Discovery now keeps the excerpt each
// aggregator prints beside its link, and the lane scores that excerpt (excerpt-only, the regular pipeline's path) when
// the page text cannot be scored. Real functions only (CLAUDE.md section 15); fetch and models are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const inl = require('../../scripts/lib/opening-night-lane/inline-score.js');
const lf = require('../../scripts/lib/opening-night-lane/lane-failures.js');
const trust = require('../../scripts/lib/opening-night-lane/trust-model.js');
const { EnsembleReviewScorer } = require('../../scripts/llm-scoring/ensemble-scorer');

const NIGHT = '2026-10-22';
const NOW = Date.parse('2026-10-22T23:30:00-04:00');
const WSJ = 'https://www.wsj.com/articles/the-imaginary-invalid-review-bill-irwins-hilarious-hypochondriac-ff88aa6b';
const QUOTE = 'And, after the thickets of complications have been cleared away to allow for the happy ending comedy requires, Mr. Irwin rises to offer us a final lagniappe.';
const SHOW = { id: 'the-imaginary-invalid-2026', title: 'The Imaginary Invalid', category: 'broadway', openingDate: NIGHT };

// The two layouts as they were on the night (structure of the live pages, text shortened).
const BWW_ROUNDUP = `<html><body><article><div class="disnep-area">
  <p><img src="https://cloudimages.broadwayworld.com/middletrans2.png">Charles Isherwood, <a href="${WSJ}" target="_blank">Wall Street Journal:</a> ${QUOTE}</p>
  <p><img src="https://cloudimages.broadwayworld.com/uptrans2.png">Helen Shaw, <a href="https://www.nytimes.com/2026/10/22/theater/imaginary-invalid-review-bill-irwin-moliere.html">The New York Times:</a> I hesitate to lessen the enchantment by telling you that it is relevant, too.</p>
  <p>Read the reviews: <a href="https://nypost.com/2026/10/22/entertainment/the-imaginary-invalid-review-x/">Post</a> and <a href="https://deadline.com/2026/10/the-imaginary-invalid-broadway-review-bill-irwin-1237169589/">Deadline</a>, both worth a look tonight.</p>
</div></article></body></html>`;
const DTLI_PAGE = `<html><body><section class="section-review-page">
  <div class="review-item"><div class="review-item-header"><img alt="NEW YORK TIMES" src="x.png"><h2><a href="/?s=Helen Shaw&searchfor=critics">Helen<br />Shaw</a></h2></div>
    <h3 class="review-item-date">October 22, 2026</h3>
    <p class="paragraph">Dirden's exquisite production, though, is both amusing and wise. That time vanishes in a swirl.</p>
    <a href="https://www.nytimes.com/2026/10/22/theater/imaginary-invalid-review-bill-irwin-moliere.html" class="button-pink review-item-button">READ THE REVIEW</a>
  </div>
  <div class="review-item"><h3 class="review-item-date">October 22, 2026</h3>
    <a href="https://www.vulture.com/article/broadway-review-bill-irwin-rachel-bloom-the-imaginary-invalid.html">READ THE REVIEW</a>
  </div>
</section></body></html>`;

test('the excerpt an aggregator prints beside each link is kept, from BWW and DTLI layouts alike', () => {
  const bww = d.extractCitedLinks(BWW_ROUNDUP, 'https://www.broadwayworld.com/article/Review-Roundup-THE-IMAGINARY-INVALID');
  const wsj = bww.find((l) => l.url.includes('wsj.com'));
  assert.ok(wsj.excerpt.startsWith('Charles Isherwood,'), wsj.excerpt);
  assert.ok(wsj.excerpt.includes('final lagniappe'));
  assert.ok(!wsj.excerpt.includes('Wall Street Journal:'), 'the anchor itself is not part of the quote');
  // One paragraph citing two reviews is a listing: whose words are they? Neither gets them.
  assert.equal(bww.find((l) => l.url.includes('deadline.com')).excerpt, null);
  assert.equal(bww.find((l) => l.url.includes('nypost.com')).excerpt, null);

  const dtli = d.extractCitedLinks(DTLI_PAGE, 'https://didtheylikeit.com/shows/the-imaginary-invalid/');
  const nyt = dtli.find((l) => l.url.includes('nytimes.com'));
  assert.match(nyt.excerpt, /exquisite production/);
  assert.ok(nyt.excerpt.startsWith('Helen Shaw '), nyt.excerpt);
  assert.ok(!/READ THE REVIEW/.test(nyt.excerpt));
  assert.equal(dtli.find((l) => l.url.includes('vulture.com')).excerpt, null, 'a date alone is not an excerpt');
});

test('aggregator adapters put the excerpt in its review-file field, and the pass carries it (merged across sources) to the admitted row', async () => {
  const home = 'https://didtheylikeit.com/';
  const page = 'https://didtheylikeit.com/shows/the-imaginary-invalid/';
  const pages = {
    [home]: `<html><body><a href="${page}">The Imaginary Invalid</a></body></html>`,
    [page]: DTLI_PAGE,
  };
  const fetchText = async (u) => { if (!(u in pages)) throw new Error(`404 ${u}`); return pages[u]; };
  const fromDtli = await d.dtliAdapter().discover({ show: SHOW, fetchText });
  const nytCand = fromDtli.find((c) => c.url.includes('nytimes.com'));
  assert.match(nytCand.excerpts.dtliExcerpt, /exquisite production/);
  assert.equal(fromDtli.find((c) => c.url.includes('vulture.com')).excerpts, undefined);

  // The same review cited by a second aggregator: both quotes reach the admitted row.
  const second = { name: 'second', phase: 'cheap', discover: async () => [{ url: nytCand.url, source: 'aggregator', aggregatorCited: true, via: 'x', excerpts: { bwwExcerpt: 'Helen Shaw, I hesitate to lessen the enchantment.' } }] };
  const first = { name: 'first', phase: 'cheap', discover: async () => fromDtli };
  const pass = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: NOW, startedAt: NOW, fetchText, adapters: [first, second] });
  const row = pass.admitted.find((a) => a.url.includes('nytimes.com'));
  assert.match(row.excerpts.dtliExcerpt, /exquisite/);
  assert.match(row.excerpts.bwwExcerpt, /Helen Shaw/);
});

function scoring({ extract, scoreText, retryMs = [1000], dir, now = () => NOW, fetchPage }) {
  return inl.createInlineScoring({
    show: SHOW, night: NIGHT, ledgerDir: dir, now, retryMs,
    fetchPage: fetchPage || (async () => ({ content: '<html>teaser</html>' })), extractArticle: extract, scoreText,
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro6066-excerpt-'));
const WSJ_CAND = { url: WSJ, key: d.canonicalUrl(WSJ), excerpts: { bwwExcerpt: `Charles Isherwood, ${QUOTE}` } };

test('a paywall teaser with an aggregator excerpt is scored from the excerpt with no aggregatorFor wiring (the real lane)', async () => {
  const dir = tmp();
  try {
    const seen = [];
    let t = NOW;
    const sc = scoring({ dir, now: () => t, extract: () => 'Subscribe to read.', scoreText: async (text, ctx) => { seen.push({ text, ctx }); return { score: 88 }; } });
    // An empty page is fetched again first (a Cloudflare page or a transient block looks the same); the same result
    // twice ends the retries and the excerpt is scored.
    await assert.rejects(sc.fetchReview(WSJ_CAND), inl.LaneRetryError);
    t += 1000;
    const got = await sc.fetchReview(WSJ_CAND);
    assert.equal(got.fullText, '');
    assert.equal(got.contentTier, 'excerpt');
    assert.match(got.excerpts.bwwExcerpt, /lagniappe/);
    const row = trust.buildLaneReview({ showId: SHOW.id, night: NIGHT, source: 'aggregator', seenAt: new Date(NOW).toISOString(), outletId: 'wsj', url: WSJ, fullText: got.fullText, aggregator: got.aggregator, excerpts: got.excerpts });
    assert.match(row.bwwExcerpt, /lagniappe/, 'the excerpt is written to the review file');
    assert.equal(row.needsRecollection, true);
    assert.equal(row.assignedScore, undefined, 'no thumb: the scorer, not the trust model, scores it');
    assert.equal(await sc.scoreReview(row, got), 88);
    assert.equal(seen[0].ctx.contentTier, 'excerpt');
    assert.match(seen[0].ctx.excerpts.bwwExcerpt, /lagniappe/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the same teaser with no excerpt still fails visibly (nothing to score)', async () => {
  const dir = tmp();
  try {
    const sc = scoring({ dir, extract: () => 'Subscribe to read.', scoreText: async () => ({ score: 1 }) });
    await assert.rejects(sc.fetchReview({ url: WSJ }), /no aggregator score or excerpt/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('200-299 chars: the scorer refuses even a partial copy, so the last attempt scores the excerpt, or fails without one', async () => {
  const text = 'A short teaser of the review that the paywall lets through. '.repeat(4).slice(0, 250);
  for (const withExcerpt of [true, false]) {
    const dir = tmp();
    try {
      let t = NOW;
      const scored = [];
      const sc = inl.createInlineScoring({
        show: SHOW, night: NIGHT, ledgerDir: dir, now: () => t, retryMs: [1000],
        fetchPage: async () => ({ content: 'x' }), extractArticle: () => text, scoreText: async (tx, ctx) => { scored.push(ctx.contentTier); return { score: 70 }; },
      });
      const cand = withExcerpt ? WSJ_CAND : { url: WSJ };
      await assert.rejects(sc.fetchReview(cand), inl.LaneRetryError);
      t += 1000;
      if (withExcerpt) {
        const got = await sc.fetchReview(cand);
        assert.equal(got.contentTier, 'excerpt');
        assert.equal(got.fullText, '', 'text the scorer would refuse is not sent');
        assert.match(lf.readFailures(dir, SHOW.id, NIGHT).failures.at(-1).reason, /scoring the aggregator excerpt/);
      } else {
        await assert.rejects(sc.fetchReview(cand), (e) => e.permanent === true && /under the 300 a partial copy needs/.test(e.message));
        assert.deepEqual(scored, [], 'never sent to a scorer that would refuse it');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('the scorer refusing the page text (input_validation_failed) rescores from the excerpt; a wrong-show verdict never does', async () => {
  const dir = tmp();
  try {
    const body = 'Sign in. Subscribe. '.repeat(80);
    const calls = [];
    const sc = scoring({ dir, extract: () => body, scoreText: async (text, ctx) => {
      calls.push({ text, tier: ctx.contentTier });
      return text ? { rejected: true, rejection: 'input_validation_failed:nav_chrome_majority' } : { score: 86, extra: { llmScore: { score: 86 } } };
    } });
    const got = await sc.fetchReview(WSJ_CAND);
    const res = await sc.scoreReview({ url: WSJ, fullText: got.fullText, showId: SHOW.id }, got);
    assert.equal(res.score, 86);
    assert.equal(res.extra.contentTier, 'excerpt');
    assert.equal(res.extra.fullText, '', 'the refused page text is not kept');
    assert.equal(res.extra.needsRecollection, true);
    assert.deepEqual(res.extra.llmScore, { score: 86 });
    assert.deepEqual(calls.map((c) => c.tier), ['complete', 'excerpt']);

    const wrongShow = scoring({ dir: tmp(), extract: () => body, scoreText: async () => ({ rejected: true, rejection: 'wrong_show' }) });
    const g2 = await wrongShow.fetchReview(WSJ_CAND);
    await assert.rejects(wrongShow.scoreReview({ url: WSJ, fullText: g2.fullText, showId: SHOW.id }, g2), (e) => e.permanent === true && /wrong_show/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The real scorer's input gate on the exact file ensembleScoreText builds: the excerpt passes it, the teaser does not.
test('through the real ensemble input gate: an excerpt-only lane review passes, the paywall teaser it replaces is refused', async () => {
  const real = Object.create(EnsembleReviewScorer.prototype);
  const results = [];
  const scorer = { scoreReviewFile: async (file) => {
    const prepared = real.prepareScoringInput(file);
    results.push(prepared);
    return prepared.ok ? { success: true, scoredFile: { assignedScore: 85 } } : prepared.failure;
  } };
  const ctx = { showId: SHOW.id, showTitle: SHOW.title, category: 'broadway', outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'Charles Isherwood', url: WSJ };
  const ok = await inl.ensembleScoreText(scorer)('', { ...ctx, contentTier: 'excerpt', excerpts: WSJ_CAND.excerpts });
  assert.equal(ok.score, 85);
  assert.equal(results[0].prep.scoringInput.textQuality, 'excerpt-only');
  const teaser = 'The Imaginary Invalid review: Bill Irwin is a hilarious hypochondriac. Subscribe to continue reading this article. '.repeat(3);
  const refused = await inl.ensembleScoreText(scorer)(teaser, { ...ctx, contentTier: 'complete' });
  assert.equal(refused.rejected, true);
  assert.match(refused.rejection, /^input_validation_failed:body_too_short/);
});

// Ship-check findings (Codex review): the excerpt must be the aggregator's entry for that review, nothing nearby.
test('only an entry block or a review card gives an excerpt; same-site links keep their words; under 50 chars is no excerpt', () => {
  const page = 'https://www.broadwayworld.com/article/x';
  const html = `<html><body><article>
    <div class="intro">The critics have weighed in on the starry revival tonight, and the verdict is split down the middle. <a href="https://www.vulture.com/article/broadway-review-the-imaginary-invalid.html">READ</a></div>
    <p><a href="https://www.broadwayworld.com/people/Sara-Holdren/">Sara Holdren</a>, <a href="https://www.wsj.com/articles/the-imaginary-invalid-review-x">Wall Street Journal:</a> At the center of this whirligig sits Irwin, often literally.</p>
    <p>Jo Smith, <a href="https://deadline.com/2026/10/the-imaginary-invalid-review-1/">Deadline:</a> Fun.</p>
  </article></body></html>`;
  const links = d.extractCitedLinks(html, page);
  assert.equal(links.find((l) => l.url.includes('vulture.com')).excerpt, null, "a plain container's prose is never a critic's quote");
  assert.match(links.find((l) => l.url.includes('wsj.com')).excerpt, /^Sara Holdren, At the center/, 'a same-site link keeps its text');
  assert.equal(links.find((l) => l.url.includes('deadline.com')).excerpt, null, 'too short for the scorer to take');
  assert.deepEqual(inl.usableExcerpts({ bwwExcerpt: 'x'.repeat(49), dtliExcerpt: 'y'.repeat(50), notAField: 'z'.repeat(80) }), { dtliExcerpt: 'y'.repeat(50) });
});

test('a 403 with only an excerpt retries first (a proxy 403 is often transient), then scores the excerpt when retries run out', async () => {
  const dir = tmp();
  try {
    let t = NOW;
    let fetches = 0;
    const blocked = async () => { fetches++; const e = new Error('HTTP 403'); e.status = 403; throw e; };
    const sc = scoring({ dir, now: () => t, retryMs: [1000], fetchPage: blocked, extract: () => '', scoreText: async () => ({ score: 80 }) });
    await assert.rejects(sc.fetchReview(WSJ_CAND), inl.LaneRetryError);
    t += 1000;
    const got = await sc.fetchReview(WSJ_CAND);
    assert.equal(fetches, 2);
    assert.equal(got.contentTier, 'excerpt');
    assert.equal(got.fallbackReason, 'fetch-exhausted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('page text is scored without the aggregator quote mixed in; the quote is only the text of an excerpt-only score', async () => {
  const dir = tmp();
  try {
    const seen = [];
    const sc = scoring({ dir, extract: () => 'A whole review body of The Imaginary Invalid. '.repeat(40), scoreText: async (text, ctx) => { seen.push(ctx); return { score: 75 }; } });
    const got = await sc.fetchReview(WSJ_CAND);
    assert.equal(await sc.scoreReview({ url: WSJ, fullText: got.fullText, showId: SHOW.id }, got), 75);
    assert.equal(seen[0].excerpts, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
