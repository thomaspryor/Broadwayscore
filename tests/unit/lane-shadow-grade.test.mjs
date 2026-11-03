// BRO-6872: the graded replay gate. canonicalUrl maps an outlet's old host to its current one (The Independent was
// scored twice on 2026-10-29, once per host), the grader reads a shadow report into pass/fail checks, and a replayed
// night runs on a clock anchored at its embargo so the trust window judges rows as on the night.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalUrl } = require('../../scripts/lib/opening-night-lane/discovery.js');
const grade = require('../../scripts/lib/lane-shadow-grade.js');
const shadow = require('../../scripts/lib/opening-night-lane-shadow.js');
const trust = require('../../scripts/lib/opening-night-lane/trust-model.js');
const { mergeShowRows } = require('../../scripts/lib/opening-night-lane/publish.js');
const { createReplaySitePorts } = require('../../scripts/lib/lane-replay-grade.js');

const IND = '/arts-entertainment/theatre-dance/features/a-few-good-men-broadway-review-bradley-whitford-tom-blyth-b3075938.html';

test('one Independent review on both hosts has one canonical key', () => {
  assert.equal(canonicalUrl(`https://www.independent.co.uk${IND}`), canonicalUrl(`https://www.the-independent.com${IND}`));
  assert.equal(canonicalUrl('https://online.wsj.com/articles/x-1'), 'https://wsj.com/articles/x-1');
  assert.equal(canonicalUrl('https://www.thetimes.co.uk/article/x'), 'https://thetimes.com/article/x');
  assert.equal(canonicalUrl('https://amp.theguardian.com/stage/x/amp'), 'https://theguardian.com/stage/x');
  // Only exact old hosts move: a host that merely contains one stays itself.
  assert.equal(canonicalUrl('https://notindependent.co.uk/x'), 'https://notindependent.co.uk/x');
});

const rev = (side, o) => ({ side, laneScoredAt: side === 'site-only' ? null : '2026-10-30T02:20:00Z', siteLiveAt: side === 'lane-only' ? null : '2026-10-30T03:00:00Z', ...o });
const REPORT = {
  show: 'x-2026', night: '2026-10-29', startedAt: '2026-10-30T02:00:00Z', laneErrorsByAdapter: {},
  reviews: [
    rev('both', { url: `https://the-independent.com${IND}`, outlet: 'independent', critic: null, laneScore: 74, siteScore: 78 }),
    rev('lane-only', { url: `https://independent.co.uk${IND}`, outlet: 'independent', critic: 'Caitlin Hornik', laneScore: 78 }),
    rev('both', { url: 'https://nystagereview.com/2026/10/29/a', outlet: 'nysr', critic: 'Frank Scheck', laneScore: 63, siteScore: 55, laneTextChars: 4671, laneContentTier: 'complete' }),
    rev('both', { url: 'https://nystagereview.com/2026/10/29/b', outlet: 'nysr', critic: 'Melissa Rose Bernardo', laneScore: 70, siteScore: 69 }),
    rev('site-only', { url: 'https://www.jkstheatrescene.com/2026/10/review.html', outlet: "JK's Theatre Scene", siteScore: 88 }),
  ],
};

test('the grade: recall, lane-only rows, the cross-host duplicate, score gaps, time to score', () => {
  const g = grade.gradeShadowReport(REPORT, { replayAnchorAt: '2026-10-30T02:00:00Z', sandbox: [{}, {}] });
  assert.equal(g.recall, 0.75);
  assert.equal(g.falsePositives.length, 1);
  assert.equal(g.duplicates.length, 1, 'the two Independent copies are one review');
  assert.equal(g.duplicates[0].length, 2);
  assert.deepEqual(g.scoreGaps.map((d) => d.delta), [8]);
  assert.equal(g.timeToScoreMin.median, 20);
  assert.equal(g.pass, false);
  assert.equal(g.onTimeRecall, 0.75);
  assert.deepEqual(g.checks.filter((c) => !c.pass).map((c) => c.name), ['onTimeRecall', 'duplicates']);
  // Two named nysr critics are two reviews.
  assert.ok(!g.duplicates.flat().some((r) => /nystagereview/.test(r.url)));
  assert.match(grade.gradeMarkdown(g), /FAIL/);
});

test('recall is gated on reviews dated by night + 1; a later magazine review is reported, not gated', () => {
  const rep = { ...REPORT, reviews: [
    ...REPORT.reviews.filter((r) => r.side === 'both' && r.outlet === 'nysr'),
    rev('site-only', { url: 'https://www.newyorker.com/magazine/2026/11/09/x', outlet: 'The New Yorker', siteScore: 80, siteDate: '2026-11-02' }),
    rev('site-only', { url: 'https://www.jkstheatrescene.com/2026/10/review.html', outlet: "JK's Theatre Scene", siteScore: 88, siteDate: '2026-10-30' }),
    rev('site-only', { url: 'https://example.com/undated', outlet: 'Undated', siteScore: 70 }),
  ] };
  const g = grade.gradeShadowReport(rep);
  assert.equal(g.recall, 0.4); // 2 of 5, all time
  assert.equal(g.onTimeRecall, 0.5); // 2 of 4: the New Yorker (dated 11/02) is out; night+1 and undated stay in
  assert.deepEqual(g.missed.filter((m) => m.late).map((m) => m.outlet), ['The New Yorker']);
  assert.match(grade.gradeMarkdown(g), /dated 2026-11-02, after the night/);
});

test('publish errors fail the grade even at full recall', () => {
  const rep = { ...REPORT, reviews: REPORT.reviews.filter((r) => r.side === 'both' && r.outlet === 'nysr'), laneErrorsByAdapter: { publish: { count: 54, first: 'not a lane review' } } };
  const g = grade.gradeShadowReport(rep);
  assert.equal(g.recall, 1);
  assert.deepEqual(g.checks.filter((c) => !c.pass).map((c) => c.name), ['publishErrors']);
});

test('replay clock: a past night starts at its embargo; a night inside the window keeps the real clock', () => {
  const show = { id: 'the-imaginary-invalid-2026', openingDate: '2026-10-22', category: 'broadway' };
  let real = Date.parse('2026-11-03T01:00:00Z');
  const c = shadow.replayClock({ show, night: '2026-10-22', realNow: () => real });
  assert.equal(c.anchorAt, '2026-10-23T02:00:00.000Z');
  real += 90 * 60000;
  assert.equal(new Date(c.now()).toISOString(), '2026-10-23T03:30:00.000Z', 'advances in real time');
  assert.equal(shadow.replayClock({ show: { ...show, openingDate: '2026-11-02' }, night: '2026-11-02', realNow: () => real }), null);
  assert.ok(shadow.replayClock({ show: { ...show, openingDate: '2026-11-02' }, night: '2026-11-02', realNow: () => real, force: true }));
});

test('on the replay clock a lane row passes the real publish merge into the sandbox site; on today\'s clock it is refused', async () => {
  const show = { id: 'the-imaginary-invalid-2026', openingDate: '2026-10-22', category: 'broadway' };
  const c = shadow.replayClock({ show, night: '2026-10-22', realNow: () => Date.parse('2026-11-03T01:00:00Z') });
  const mk = (seenAt) => trust.buildLaneReview({ showId: show.id, night: '2026-10-22', source: 'aggregator', seenAt, outletId: 'nytimes', outlet: 'The New York Times', criticName: 'A Critic', url: 'https://www.nytimes.com/2026/10/22/theater/x-review.html', publishDate: '2026-10-22', fullText: 'y'.repeat(2000), aggregator: {} });
  const onNight = { ...mk(new Date(c.now()).toISOString()), assignedScore: 80 };
  const today = { ...mk('2026-11-03T01:00:00.000Z'), assignedScore: 80 };
  assert.throws(() => mergeShowRows({ reviews: [] }, show.id, [today], { openingDate: show.openingDate }), /not a lane review/);
  const site = createReplaySitePorts({ now: c.now });
  await site.updateReviews((doc) => mergeShowRows(doc, show.id, [onNight], { openingDate: show.openingDate }));
  await site.deploy();
  assert.equal(site.live().length, 1);
});

test('a missing byline alone does not make two same-outlet reviews a duplicate', () => {
  const rep = { show: 'x', night: '2026-10-29', reviews: [
    rev('both', { url: 'https://www.nytimes.com/2026/10/29/theater/a-review.html', outlet: 'nytimes', critic: 'Jesse Green', laneScore: 80, siteScore: 80 }),
    rev('both', { url: 'https://www.nytimes.com/2026/10/30/theater/b-critics-notebook.html', outlet: 'nytimes', critic: null, laneScore: 70, siteScore: 70 }),
  ] };
  assert.equal(grade.gradeShadowReport(rep).duplicates.length, 0);
});

// BRO-6872 round 9: the regular pipeline's own first sighting (firstSeenAt, sources) settles the rows a publish date
// cannot. Cases are the Oct 2026 replays: Max Hechtman (preview-period blog post production had the morning of opening day),
// Thedaviddesk2 (found 8 days later, dated "2026-10"), Cititour and Lighting & Sound America (undated pages).
test('site rows: already live, undated pages by first sighting', () => {
  const ctx = (meta) => ({ nightPlus1: '2026-10-22', laneStartMs: Date.parse('2026-10-21T23:00:00Z'), meta });
  const v = grade.siteRowVerdict;
  assert.equal(v({ siteDate: '2026-10-04' }, ctx({ firstSeenAt: '2026-10-21T09:36:12Z', sources: ['submit-review-form'] })), 'already-live');
  // 'submit-review-form' is every ingest-review-from-url caller's label, so it is no reason to set a row aside.
  assert.equal(v({ siteDate: '2026-10' }, ctx({ firstSeenAt: '2026-10-29T01:16:08Z', sources: ['submit-review-form'] })), 'late');
  assert.equal(v({ siteDate: '2026-10-22' }, ctx({ firstSeenAt: '2026-10-31T20:49:28Z', sources: ['submit-review-form', 'bww-reviews'] })), 'on-time');
  // Undated: the day production first saw it, in New York time (03:17Z on the 22nd is still the 21st there).
  assert.equal(v({ siteDate: null }, ctx({ firstSeenAt: '2026-10-22T03:17:25Z', sources: ['ingest-urls'] })), 'on-time');
  assert.equal(v({ siteDate: null }, ctx({ firstSeenAt: '2026-10-29T17:24:00Z', sources: ['outlet-listing-poller'] })), 'late');
  // A month-only date is no date: it used to compare as on time ("2026-10" < "2026-10-22").
  assert.equal(v({ siteDate: '2026-10' }, ctx({ firstSeenAt: '2026-10-29T17:24:00Z', sources: ['outlet-listing-poller'] })), 'late');
  // A full date still wins over a late first sighting (the lane can find what production found late).
  assert.equal(v({ siteDate: '2026-10-22' }, ctx({ firstSeenAt: '2026-10-23T12:10:16Z', sources: ['serp-discovery'] })), 'on-time');
  assert.equal(v({ siteDate: '2026-10-25' }, ctx(null)), 'late');
  // Nothing known: on time, as before.
  assert.equal(v({ siteDate: null }, ctx(null)), 'on-time');
});

test('one review under a typo URL and its real URL is one review (near-identical slug)', () => {
  const j = grade.joinNearSlugs([
    { side: 'site-only', url: 'https://culturesauce.com/ther-desert-cities-julia-louis-dreyfus-broadway-review', siteScore: 80, outlet: 'Culture Sauce' },
    { side: 'lane-only', url: 'https://culturesauce.com/other-desert-cities-julia-louis-dreyfus-broadway-review/', laneScore: 82, outlet: 'culturesauce' },
    // Two different reviews on one host stay apart, and so do short slugs.
    { side: 'site-only', url: 'https://example.com/review-of-show-one-at-the-imperial', siteScore: 70 },
    { side: 'lane-only', url: 'https://example.com/review-of-show-two-at-the-booth-theatre', laneScore: 70 },
    { side: 'site-only', url: 'https://example.com/a/review-1', siteScore: 60 },
    { side: 'lane-only', url: 'https://example.com/a/review-2', laneScore: 60 },
  ]);
  const cs = j.filter((r) => /culturesauce/.test(r.url));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].side, 'both'); assert.equal(cs[0].joinedBy, 'near-slug'); assert.equal(cs[0].siteScore, 80);
  assert.equal(j.filter((r) => r.side !== 'both').length, 4);
});

test('near-slug join never pairs two articles', () => {
  const pairs = (rows) => grade.joinNearSlugs(rows).filter((r) => r.joinedBy === 'near-slug').length;
  const L = (url) => ({ side: 'lane-only', url, laneScore: 80 }); const S = (url) => ({ side: 'site-only', url, siteScore: 40 });
  // WordPress "-2" for a repeated slug, and part-1 / part-2: two articles.
  assert.equal(pairs([L('https://x.com/a/hamlet-broadway-review-2'), S('https://x.com/a/hamlet-broadway-review')]), 0);
  assert.equal(pairs([L('https://x.com/a/review-hamlet-part-2'), S('https://x.com/a/review-hamlet-part-1')]), 0);
  // Same slug under another section is another article.
  assert.equal(pairs([L('https://x.com/news/hamlet-broadway-reviews'), S('https://x.com/blog/hamlet-broadway-review')]), 0);
  // Two lane rows that could both claim one site row: neither pairs.
  assert.equal(pairs([L('https://x.com/a/hamlet-broadway-reviews'), L('https://x.com/a/hamlet-broadway-reviewx'), S('https://x.com/a/hamlet-broadway-review')]), 0);
  // A one-letter typo in the same section pairs.
  assert.equal(pairs([L('https://x.com/a/hamlet-broadway-review'), S('https://x.com/a/hamlet-brodway-review')]), 1);
});

test('duplicate review files for one URL keep the earliest first sighting', () => {
  const m = grade.loadSiteMetaFromDir(null, [
    { name: 'a.json', json: { url: 'https://x.com/a/review-of-the-show', firstSeenAt: '2026-10-19T17:17:20Z' } },
    { name: 'b.json', json: { url: 'https://x.com/a/review-of-the-show/', firstSeenAt: '2026-10-19T05:24:03Z' } },
  ]);
  assert.equal([...m.values()][0].firstSeenAt, '2026-10-19T05:24:03Z');
});

test('the grade sets aside already-live rows on both sides and reads undated rows by first sighting', () => {
  const r = (side, url, siteDate = null) => ({ side, url, siteDate, laneScoredAt: side === 'site-only' ? null : '2026-10-22T03:00:00Z', laneScore: side === 'site-only' ? null : 70, siteScore: side === 'lane-only' ? null : 70 });
  const rep = { show: 'x-2026', night: '2026-10-21', startedAt: '2026-10-21T23:00:00Z', laneErrorsByAdapter: {}, reviews: [
    r('both', 'https://a.com/review-aaaaaaaaaaaa', '2026-10-21'),
    r('both', 'https://b.com/review-bbbbbbbbbbbb', '2026-10-21'),
    r('both', 'https://c.com/review-cccccccccccc', '2026-10-21'),
    r('site-only', 'https://maxhechtmanfilms.com/blog/billy-crystal-860-filmmaker-review', '2026-10-04'),
    r('site-only', 'https://thedaviddesk2.blogspot.com/2026/10/broadway-review-billy-crystal-860.html', '2026-10'),
    r('site-only', 'https://cititour.com/NYC_Broadway/860/1402'),
    r('site-only', 'https://lightingandsoundamerica.com/news/story.asp?ID=TNMYVQ'),
  ] };
  const { canonicalUrl: cu } = require('../../scripts/lib/opening-night-lane/discovery.js');
  const siteMeta = new Map([
    [cu('https://maxhechtmanfilms.com/blog/billy-crystal-860-filmmaker-review'), { firstSeenAt: '2026-10-21T09:36:12Z', sources: ['submit-review-form'] }],
    [cu('https://thedaviddesk2.blogspot.com/2026/10/broadway-review-billy-crystal-860.html'), { firstSeenAt: '2026-10-29T01:16:08Z', sources: ['submit-review-form'] }],
    [cu('https://cititour.com/NYC_Broadway/860/1402'), { firstSeenAt: '2026-10-22T03:17:25Z', sources: ['ingest-urls', 'playbill-verdict'] }],
    [cu('https://lightingandsoundamerica.com/news/story.asp?ID=TNMYVQ'), { firstSeenAt: '2026-10-29T17:24:00Z', sources: ['outlet-listing-poller'] }],
  ]);
  const before = grade.gradeShadowReport(rep, { replayAnchorAt: '2026-10-22T02:00:00Z' });
  assert.equal(before.onTimeRecall, 0.429); // 3 of 7: every site-only row counted
  const g = grade.gradeShadowReport(rep, { replayAnchorAt: '2026-10-22T02:00:00Z', siteMeta });
  assert.equal(g.onTimeRecall, 0.75); // 3 of 4: Cititour is a real miss, L&SA and the David Desk late, Hechtman already live
  assert.deepEqual(g.excluded.map((x) => x.why).sort(), ['already-live']);
  assert.equal(g.missed.find((m) => /lightingandsound/.test(m.url)).late, true);
  assert.equal(rep.reviews[3].onTimeVerdict, undefined, 'the report itself is not modified');
  assert.match(grade.gradeMarkdown(g), /Not gated/);
});

// BRO-6872 finding 5: the 2026-10 replays flagged nytg 62/48 and theatermania 62/48 as 14-point gaps on complete text.
// Both site rows are ensemble scores whose own three models were 18 and 13 points apart, so a rescore of the SAME text
// moves that far: a gap inside the answer key's spread is model variance, not a lane text defect.
test('a score gap inside the answer key’s own ensemble spread is not counted against the lane', () => {
  const url = 'https://www.newyorktheatreguide.com/reviews/x';
  const rep = { ...REPORT, reviews: [rev('both', { url, outlet: 'nytg', critic: 'A B', laneScore: 62, siteScore: 48, laneTextChars: 5000, laneContentTier: 'complete' })] };
  const spread = new Map([[canonicalUrl(url), { spread: 18, agreement: '2/3 models agree: Negative', confidence: 'medium', source: 'llm-v6' }]]);
  const g = grade.gradeShadowReport(rep, { replayAnchorAt: '2026-10-30T02:00:00Z', siteScoreSpread: spread });
  assert.deepEqual(g.scoreGaps.map((d) => d.delta), [14], 'still reported');
  assert.equal(g.scoreGaps[0].siteScoreSpread, 18);
  assert.equal(g.scoreGaps[0].beyondEnsemble, false);
  assert.deepEqual(g.scoreGapsBeyondEnsemble, []);
  assert.ok(g.checks.find((c) => c.name === 'scoreGapsBeyondEnsemble').pass);
  assert.match(grade.gradeMarkdown(g), /within ensemble/);
});

test('a gap wider than the spread, and a row with no spread at all, still count', () => {
  const tight = 'https://www.newyorktheatreguide.com/reviews/tight';
  const none = 'https://www.vulture.com/2026/10/no-spread.html';
  const rep = { ...REPORT, reviews: [
    rev('both', { url: tight, outlet: 'nytg', laneScore: 62, siteScore: 48 }),
    rev('both', { url: none, outlet: 'vulture', laneScore: 80, siteScore: 60 }),
  ] };
  const spread = new Map([[canonicalUrl(tight), { spread: 4, agreement: '3/3 models agree: Positive', confidence: 'high', source: 'llm-v6' }]]);
  const g = grade.gradeShadowReport(rep, { replayAnchorAt: '2026-10-30T02:00:00Z', siteScoreSpread: spread });
  assert.deepEqual(g.scoreGapsBeyondEnsemble.map((d) => Math.abs(d.delta)).sort((a, b) => a - b), [14, 20]);
  assert.equal(g.scoreGapsBeyondEnsemble.find((d) => d.url === none).siteScoreSpread, null, 'no spread: the flat 8-point rule');
  assert.equal(g.checks.find((c) => c.name === 'scoreGapsBeyondEnsemble').pass, false, 'two beyond-ensemble gaps fail the gate');
});

test('loadSiteScoreSpread reads the ensemble spread of the live answer key (skips without local core data)', (t) => {
  const fs = require('node:fs'); const path = require('node:path');
  const { fileURLToPath } = require('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const p = path.join(root, 'data', 'reviews.json');
  if (!fs.existsSync(p)) { t.skip('no local core data'); return; }
  const m = grade.loadSiteScoreSpread(p, 'a-few-good-men-2026');
  assert.ok(m.size > 0, 'the show has ensemble-scored reviews');
  for (const v of m.values()) assert.ok(Number.isFinite(v.spread) && v.spread >= 0, 'every entry carries a numeric spread');
  // An unknown show has no entries rather than throwing.
  assert.equal(grade.loadSiteScoreSpread(p, 'no-such-show-9999').size, 0);
});

// Review finding: the spread rule needs the GAP_PTS floor FIRST. 1,026 llm rows in reviews.json have scoreDelta 0 and
// 12,921 have 3 or less, and a fresh lane ensemble lands a few points off the same text, so without the floor two
// such rows would fail the whole replay on noise the meanAbsScoreDiff check deliberately allows.
test('a small gap never counts, even against a row whose models agreed exactly', () => {
  const tight = 'https://www.nytimes.com/2026/10/29/theater/zero-spread.html';
  const rep = { ...REPORT, reviews: [rev('both', { url: tight, outlet: 'nytimes', laneScore: 69, siteScore: 66, laneContentTier: 'complete' })] };
  const spread = new Map([[canonicalUrl(tight), { spread: 0, agreement: '3/3 models agree: Mixed', confidence: 'high', source: 'llm-v6' }]]);
  const g = grade.gradeShadowReport(rep, { replayAnchorAt: '2026-10-30T02:00:00Z', siteScoreSpread: spread });
  assert.deepEqual(g.scoreGaps, [], '3 points is under the reporting bar');
  assert.deepEqual(g.scoreGapsBeyondEnsemble, []);
  assert.ok(g.checks.find((c) => c.name === 'scoreGapsBeyondEnsemble').pass);
  assert.deepEqual(g.siteScoreSpread, { reviews: 1, matched: 1, ofDiffs: 1 });
  assert.match(grade.gradeMarkdown(g), /spread known for 1 of 1/);
});

// The hole the reviewers pressed on: a paywall teaser scored 15 points off a row with an 18-point spread would be
// excused as model variance. Incomplete lane text is evidence of a TEXT difference, so the spread cannot excuse it.
test('a wide gap on text the lane did not get whole counts however wide the spread', () => {
  const url = 'https://www.wsj.com/arts-culture/teaser.html';
  const rep = { ...REPORT, reviews: [rev('both', { url, outlet: 'wsj', laneScore: 63, siteScore: 48, laneTextChars: 645, laneContentTier: 'truncated' })] };
  const spread = new Map([[canonicalUrl(url), { spread: 18, agreement: '2/3 models agree: Negative', confidence: 'medium', source: 'llm-v6' }]]);
  const g = grade.gradeShadowReport(rep, { replayAnchorAt: '2026-10-30T02:00:00Z', siteScoreSpread: spread });
  assert.deepEqual(g.scoreGapsBeyondEnsemble.map((d) => d.delta), [15]);
  assert.equal(g.checks.find((c) => c.name === 'scoreGapsBeyondEnsemble').pass, true, 'one such row is within the threshold');
  // The same gap on complete text is model variance.
  const whole = { ...REPORT, reviews: [rev('both', { url, outlet: 'wsj', laneScore: 63, siteScore: 48, laneTextChars: 7000, laneContentTier: 'complete' })] };
  assert.deepEqual(grade.gradeShadowReport(whole, { replayAnchorAt: '2026-10-30T02:00:00Z', siteScoreSpread: spread }).scoreGapsBeyondEnsemble, []);
});

test('duplicate rows for one URL keep the narrower spread, and the flat rule needs no reviews.json', () => {
  const u = 'https://www.theatermania.com/reviews/dupe';
  const rows = [
    { showId: 's', url: u, scoreSource: 'llm-v6', scoreDelta: 20, modelAgreement: 'a', scoreConfidence: 'low' },
    { showId: 's', url: `${u}?utm_source=x`, scoreSource: 'llm-v6', scoreDelta: 6, modelAgreement: 'b', scoreConfidence: 'high' },
    { showId: 's', url: 'https://x.test/star', scoreSource: 'star-rating', scoreDelta: 30 },
    { showId: 'other', url: 'https://x.test/other', scoreSource: 'llm-v6', scoreDelta: 2 },
  ];
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spread-')), 'reviews.json');
  fs.writeFileSync(p, JSON.stringify(rows));
  const m = grade.loadSiteScoreSpread(p, 's');
  assert.equal(m.get(canonicalUrl(u)).spread, 6, 'the narrower of the two duplicate rows');
  assert.equal(m.size, 1, 'a star-rated row carries no ensemble spread');
  // No file at all: an empty map, and the grade falls back to the flat rule without throwing.
  const none = grade.loadSiteScoreSpread(path.join(path.dirname(p), 'missing.json'), 's');
  assert.equal(none.size, 0);
  const g = grade.gradeShadowReport(REPORT, { replayAnchorAt: '2026-10-30T02:00:00Z', siteScoreSpread: none });
  assert.deepEqual(g.scoreGapsBeyondEnsemble.map((d) => d.delta), [8], 'the flat rule gates the 8-point gap it reports');
});
