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
  assert.deepEqual(g.checks.filter((c) => !c.pass).map((c) => c.name), ['recall', 'duplicates']);
  // Two named nysr critics are two reviews.
  assert.ok(!g.duplicates.flat().some((r) => /nystagereview/.test(r.url)));
  assert.match(grade.gradeMarkdown(g), /FAIL/);
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
