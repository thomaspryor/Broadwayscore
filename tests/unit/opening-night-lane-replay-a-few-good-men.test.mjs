// BRO-6066 (cutover card 5b): replay of the 2026-10-29 shadow night for A Few Good Men (run 40986210601). The lane scored
// 18 of the 22 reviews the site published. These pages are rebuilt from that night's inputs: the same URLs and the page
// shapes that cost the four (BWW's roundup body behind ticket-deal and podcast <article> cards, Playbill's bare link list
// with no excerpts, WSJ's paywall teaser judged not_a_review, The Independent's /features/ review path, New York Theater
// reachable only through its own feed or the BWW roundup, every Talkin' Broadway index failing). Links and structure
// only; the quotes are placeholders, no article text is copied. BRO-6073 adds the lane's Browserbase route: Talkin'
// Broadway answers only through it (as from CI, where Bright Data and ScrapingBee meet its Cloudflare challenge).
// The real runLaneNight, discovery adapters and inline scoring run; the network and the models are injected. BRO-5201: the
// replay goes through driver.wireLaneNight, the production wiring (adapters from laneAdapters, one routed fetchPage for
// discovery and review fetch, a real publish with no-op push), against an empty review-texts dir.
// The night itself (pages, expected reviews, replay) lives in scripts/lib/lane-recorded-nights/ so the recorded
// rehearsal replays exactly what these tests pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  d, inline, SHOW, NIGHT, T0, SITE, U, a, BWW_RR, PODCAST, quote, bwwPage, NYT_FEED, ALL_FEEDS, TEASER, FULL, nightFetch, replay,
} = require('../../scripts/lib/lane-recorded-nights/a-few-good-men-2026.js');
const has = (r, k) => r.scored.has(d.canonicalUrl(U[k]));

test('replay of 2026-10-29: the lane scores all 22 published reviews, Talkin\' Broadway through Browserbase (BRO-6073)', async () => {
  const r = await replay();
  const missed = Object.keys(SITE).filter((k) => !has(r, k));
  assert.deepEqual(missed, [], `missed ${missed.join(', ')}; failed ${JSON.stringify(r.failed)}; errors ${JSON.stringify(r.errors)}`);
  assert.equal(r.scored.size, 22);
  assert.deepEqual(r.failed, [], 'nothing failed for good');
  // Every Browserbase read was Talkin' Broadway, discovery and review fetch alike, in one session.
  assert.ok(r.browserbase.reads.length > 0 && r.browserbase.reads.every((u) => /talkinbroadway\.com/.test(u)), r.browserbase.reads.join(', '));
  assert.ok(r.browserbase.reads.filter((u) => d.canonicalUrl(u) === d.canonicalUrl(U.talkinbroadway)).length >= 2, 'probed, then fetched for scoring');
  assert.equal(r.browserbase.sessions(), 1);
  // The production publish path ran (not a dry run): every score was published (in batches) and written to the review-texts dir.
  assert.ok(r.published.length > 0, 'at least one publish batch'); assert.deepEqual(r.unpublished, [], 'nothing scored was left unpublished');
  assert.ok(r.reviewFiles.length > 0, 'the lane wrote its review files into the empty review-texts dir');
});

test('without Browserbase (no keys, kill switch, allowance used) the lane scores 21: Talkin\' Broadway is the only miss', async () => {
  const r = await replay({ noBrowserbase: true });
  const missed = Object.keys(SITE).filter((k) => !has(r, k));
  assert.deepEqual(missed, ['talkinbroadway']);
  assert.equal(r.scored.size, 21);
});

test('WSJ: the paywall teaser judged not_a_review waits for BWW\'s excerpt (Playbill prints none) and is scored from it once', async () => {
  const r = await replay({ bwwFromPass: 3 });
  assert.ok(has(r, 'wsj'));
  const wsj = r.scorerCalls.filter((c) => /wsj\.com/.test(c.url));
  // One model call on the teaser, then none while no excerpt exists, then one on the excerpt.
  assert.deepEqual(wsj.map((c) => c.tier), ['complete', 'excerpt']);
  assert.equal(wsj[1].chars, 0, 'the excerpt is the only text');
});

test('WSJ with no aggregator excerpt all night is still a failure for good, not a score from the teaser', async () => {
  const r = await replay({ bwwFromPass: 99, passes: 14 }); // five tries on the 30 s, 2, 5, 10 min backoff: about 18 minutes
  assert.ok(!has(r, 'wsj'));
  const f = r.failed.find((x) => x.key.includes('wsj.com'));
  assert.ok(f, JSON.stringify(r.failed));
  assert.match(f.reason, /paywall teaser \(not_a_review\); waiting for an aggregator excerpt/);
  assert.equal(r.scorerCalls.filter((c) => /wsj\.com/.test(c.url)).length, 1, 'the teaser is judged once, never re-sent to the models');
});

test('The Independent\'s /features/ review is admitted; the shared rule with domain-filters.js still refuses a features interview or round-up', async () => {
  const r = await replay();
  assert.ok(has(r, 'independent'));
  const { isBlockedReviewUrl } = require('../../scripts/lib/domain-filters.js');
  for (const u of [U.independent]) {
    assert.equal(d.nonReviewReason(d.canonicalUrl(u), { aggregatorCited: true }), null);
    assert.equal(isBlockedReviewUrl(u), false, 'the regular pipeline agrees');
  }
  for (const u of ['https://www.the-independent.com/arts-entertainment/theatre-dance/features/aaron-sorkin-interview-b3075000.html',
    'https://www.the-independent.com/arts-entertainment/theatre-dance/features/a-few-good-men-review-round-up-b3075001.html']) {
    assert.equal(d.nonReviewReason(u, { aggregatorCited: true }), 'non-review-path', u);
    assert.equal(isBlockedReviewUrl(u), true, u);
  }
});

test('New York Theater comes from its own feed when no BWW roundup is found all night (the regular pipeline\'s source)', async () => {
  const r = await replay({ bwwFromPass: 99 });
  const ny = r.admitted.find((x) => x.key === d.canonicalUrl(U.nytheater));
  assert.ok(ny, 'discovered through the feed');
  assert.equal(ny.via, 'NY Theater');
  const off = await replay({ bwwFromPass: 99, feeds: false });
  assert.ok(!has(off, 'nytheater'), 'with neither source it is not found: the feed is what finds it');
});

test('the lane reads the regular pipeline\'s feed list by default, every feed within two passes despite the per-pass cap', async () => {
  const feeds = d.defaultLaneFeeds(SHOW);
  assert.ok(feeds.some((f) => f.url === NYT_FEED));
  assert.ok(feeds.every((f) => ALL_FEEDS.some((x) => x.url === f.url)), 'no second list');
  assert.ok(!feeds.some((f) => /whatsonstage|standard\.co\.uk|theatreweekly/.test(f.url)), 'West End feeds are not read for a Broadway show');
  const asked = new Set();
  const adapter = d.rssAdapter();
  for (let i = 0; i < 2; i++) await adapter.discover({ show: SHOW, fetchText: async (u) => { asked.add(u); return '<rss></rss>'; } });
  assert.deepEqual([...asked].sort(), feeds.map((f) => f.url).sort());
});

test('BWW roundup: the cited reviews are read from the story body, not the deal and podcast cards; an unreadable layout is an error', async () => {
  const links = d.extractCitedLinks(d.bwwRoundupBody(bwwPage), BWW_RR);
  assert.equal(links.length, 20);
  assert.ok(links.every((l) => l.excerpt && l.excerpt.includes('placeholder quote')), 'each review keeps its BWW excerpt');
  assert.ok(!links.some((l) => l.url.includes('broadwaypodcastnetwork')));
  // The night's layout through the old scope: one podcast link. The adapter now says so instead of returning nothing.
  assert.deepEqual(d.extractCitedLinks(bwwPage, BWW_RR).map((l) => l.url), [d.canonicalUrl(PODCAST)]);
  const cardsOnly = bwwPage.replace(/<div class="disnep-area">[\s\S]*?<\/div>/, '');
  const fetchText = nightFetch({ bwwFromPass: 1, bwwLayout: cardsOnly });
  await assert.rejects(d.bwwRoundupAdapter().discover({ show: SHOW, fetchText }), /no review on a known outlet/);
});

// Ship-check findings (2026-10-30 review panel).
function wsjScoring({ page, url = U.wsj, now }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6066-teaser-'));
  const calls = [];
  const sc = inline.createInlineScoring({
    show: SHOW, night: NIGHT, ledgerDir: dir, now,
    fetchPage: async () => ({ content: page }), extractArticle: (html) => html, extractMeta: () => ({ criticName: 'Charles Isherwood' }),
    scoreText: async (text, ctx) => { calls.push(ctx.contentTier); return text ? { rejected: true, rejection: 'not_a_review' } : { score: 45, extra: {} }; },
  });
  return { sc, calls, dir, url };
}
const EXCERPT = { bwwExcerpt: `Charles Isherwood, ${quote('wsj')}` };

test('a teaser wait counts one attempt per try, and an excerpt seen while the score is backing off is kept', async () => {
  let t = T0;
  const { sc, calls, dir, url } = wsjScoring({ page: TEASER, now: () => t });
  try {
    const row = () => ({ url, fullText: TEASER, showId: SHOW.id });
    const got = await sc.fetchReview({ url });
    await assert.rejects(sc.scoreReview(row(), got), (e) => e.name === 'LaneRetryError' && /attempt 1\/5/.test(e.message));
    const recs = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.includes('failures'))), 'utf8').trim().split('\n');
    assert.equal(recs.length, 1, 'one failure record per try, not two');
    // Five seconds later (inside the 30 s backoff) BWW cites it with a quote: the fetch is cached, the score still waits...
    t += 5000;
    await assert.rejects(sc.fetchReview({ url, excerpts: EXCERPT }), (e) => e.name === 'LaneRetryError');
    // ...and the next try, with no aggregator re-citing it, still has the quote.
    t += 60000;
    const again = await sc.fetchReview({ url });
    const res = await sc.scoreReview(row(), again);
    assert.equal(res.score, 45);
    assert.deepEqual(calls, ['complete', 'excerpt'], 'the teaser went to the models once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('not_a_review stays a verdict for a full-length paywall page and for a short page whose URL is not a review', async () => {
  for (const [page, url] of [[FULL.slice(0, 2600), U.wsj], [TEASER, 'https://www.wsj.com/articles/aaron-sorkin-on-bringing-a-few-good-men-back-b2a4cbcb']]) {
    const { sc, dir } = wsjScoring({ page, url, now: () => T0 });
    try {
      const got = await sc.fetchReview({ url, excerpts: EXCERPT });
      await assert.rejects(sc.scoreReview({ url, fullText: page, showId: SHOW.id }, got), (e) => e.permanent === true && /not_a_review/.test(e.message), url);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a card <article> nested inside the BWW story body does not stand in for the roundup', () => {
  const nested = bwwPage.replace('<div class="disnep-area">', `<div class="disnep-area"><article class="ad">${a(U.vulture, 'Promoted')}</article>`);
  const links = d.storyCitedLinks(nested, BWW_RR, '.disnep-area');
  assert.equal(links.length, 20);
});

test('replay graded like a press night: same-night completeness PASS (S4-T6)', async () => {
  const r = await replay({ site: true });
  assert.ok(r.live.length >= 21, `live rows ${r.live.length}`);
  const g = r.graded;
  assert.equal(g.sameNight.status, 'pass', `same-night: ${g.sameNight.detail}; gates ${JSON.stringify(g.gates.map((x) => [x.name, x.status, x.detail]))}`);
  assert.deepEqual(g.runProblems, []);
});
