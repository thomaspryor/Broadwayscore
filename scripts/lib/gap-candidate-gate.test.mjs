// BRO-4190 / BRO-4540 / BRO-4583: the review-gap census counted show hubs,
// venue listings, ticket and fundraiser pages, interviews and earlier-production
// reviews as "missing reviews". Fixtures are the URLs from those cards, plus
// real reviews on the same hosts that must still count.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { classifyGapCandidateUrl } = require('./non-review-url-patterns.js');
const { censusVerdictFor } = require('./gap-audit-merge.js');
const { urlYearOf } = require('./url-discovery.js');
const { isUrlYearOutOfWindow } = require('./gap-ingest-policy.js');

const JUNK = [
  'https://www.show-score.com/off-broadway-shows/the-hope-theory',
  'https://www.show-score.com/uk/london/west-end-shows/my-son-s-a-queer-but-what-can-you-do-west-end',
  'https://bachtrack.com/opera-event/la-boheme-metropolitan-opera-25-september-2026/436175',
  'https://www.theatricalindex.com/show/the-hope-theory/',
  'https://www.zeffy.com/en-US/ticketing/a-thousand-natural-shocks',
  'https://www.ticketswap.com/event/the-last-ship/abc',
  'https://broadwaylog.app/shows/human-things',
  'https://www.operabase.com/productions/cosi-fan-tutte-123',
  'https://www.askonasholt.com/news/la-boheme-at-the-met',
  'https://www.sohoplayhouse.com/see-a-show/gimme-a-sign',
  'https://www.lwtheatres.co.uk/whats-on/the-last-ship/',
  'https://www.indiewire.com/features/general/some-interview-1234/',
  'https://youtu.be/abc123',
  'https://theatrevibe.co.uk/2026/08/03/news-the-last-ship-stings-musical-theatre-royal-drury-lane-22nd-september-to-3rd-october-2026/',
  'https://maryrobinettekowal.com/journal/my-favorite-bit/my-favorite-bit-omar-hussain-talks-about-a-thousand-natural-shocks/',
  'https://redcircle.com/shows/a-thousand-natural-shocks-with-gabe-s-dunn',
  'https://openingnight.online/crazy-mama-crazy-mama-a-true-story-of-love-and-madness-is-coming-to-59e59-theaters/',
];

const REAL = [
  'https://bachtrack.com/review-macbeth-proske-nezet-seguin-kelsey-davidsen-metropolitan-opera-new-york-september-2026',
  'https://www.whatsonstage.com/news/the-last-ship-review-london_12345/',
  'https://www.theatermania.com/news/review-the-hope-theory_12345/',
  'https://www.parterre.com/broadcast/turandot-2026/',
  'https://lovelondonloveculture.com/review-the-last-ship/',
  'https://theatrevibe.co.uk/2026/09/25/review-the-last-ship-theatre-royal-drury-lane-2026/',
  'https://www.thetheatretimes.com/the-hope-theory-review/',
  'https://www.nytimes.com/2026/10/01/theater/the-hope-theory-review.html',
];

test('junk URLs from the cluster cards are not gap candidates', () => {
  for (const u of JUNK) {
    const v = classifyGapCandidateUrl(u);
    assert.strictEqual(v.ok, false, `${u} should be rejected`);
    assert.ok(v.reason, `${u} needs a tallied reason`);
  }
});

test('a review headline with "is coming to terms/life" stays a candidate', () => {
  assert.deepStrictEqual(classifyGapCandidateUrl('https://www.thetheatretimes.com/the-hope-theory-is-coming-to-terms-with-grief/'), { ok: true, reason: null });
});

test('real reviews on the same hosts stay candidates', () => {
  for (const u of REAL) assert.deepStrictEqual(classifyGapCandidateUrl(u), { ok: true, reason: null }, u);
});

test('censusVerdictFor: a rejected URL is neither covered nor a candidate (pre-schema-3 rows)', () => {
  const real = 'https://www.thetheatretimes.com/the-hope-theory-review/';
  const hub = 'https://www.show-score.com/off-broadway-shows/the-hope-theory';
  const venue = 'https://www.sohoplayhouse.com/see-a-show/gimme-a-sign';
  const v = censusVerdictFor({
    showId: 'the-hope-theory-off-broadway-2026',
    aggregatorListedUrls: [real, hub, venue],
    missing: [{ url: hub, host: 'show-score.com' }],
    aggregatorArticles: [{ url: 'https://example.org/roundup' }],
  });
  const urls = v.candidates.map((c) => c.url);
  assert.deepStrictEqual(urls, [real]);
  assert.strictEqual(v.candidateCount, 1);
  assert.strictEqual(v.liveCount, 1);
  assert.strictEqual(v.censusSchema, 3);
});

test('urlYearOf reads BroadwayWorld compact dates, ignoring its 20010101 placeholder and bad dates', () => {
  assert.strictEqual(urlYearOf('https://www.broadwayworld.com/los-angeles/article/Review-THE-HOPE-THEORY-at-Geffen-Playhouse-20240507'), 2024);
  assert.strictEqual(urlYearOf('https://www.broadwayworld.com/minneapolis/article/Review-DIRTY-DANCING-THE-MUSICAL-at-Ordway-Center-For-The-Performing-Arts-20010101'), null);
  assert.strictEqual(urlYearOf('https://www.broadwayworld.com/article/Something-20241399'), null);
  // Only BroadwayWorld's slug shape: another host's 8-digit id is not a date.
  assert.strictEqual(urlYearOf('https://example.com/story-20240507'), null);
  assert.strictEqual(urlYearOf('https://www.nytimes.com/2026/10/01/theater/x-review.html'), 2026);
});

test('a 2024 BWW regional review is out of window for a 2026 production', () => {
  const show = { id: 'the-hope-theory-off-broadway-2026', title: 'The Hope Theory', openingDate: '2026-09-28', previewsStartDate: '2026-09-10' };
  assert.strictEqual(isUrlYearOutOfWindow('https://www.broadwayworld.com/los-angeles/article/Review-THE-HOPE-THEORY-at-Geffen-Playhouse-20240507', show), true);
  assert.strictEqual(isUrlYearOutOfWindow('https://www.broadwayworld.com/off-broadway/article/Review-THE-HOPE-THEORY-at-MCC-20261001', show), false);
});

test('blast radius: a candidate drop against an older-rule row is not risky, a live drop still is', () => {
  const { riskStateMap, isRiskyGapChange } = require('./gap-audit-merge.js');
  const old = { showId: 's', aggregatorListedUrls: [], missing: [], censusVerdict: { verdict: 'incomplete', liveCount: 4, candidateCount: 9, censusSchema: 2 } };
  assert.match(riskStateMap([old]).s, /:prior-schema$/);
  assert.doesNotMatch(riskStateMap([{ ...old, censusVerdict: { ...old.censusVerdict, censusSchema: 3 } }]).s, /prior-schema/);
  const prev = 'incomplete:4:9:prior-schema';
  assert.strictEqual(isRiskyGapChange(prev, 'incomplete:4:6'), false);
  assert.strictEqual(isRiskyGapChange(prev, 'incomplete:3:6'), true);
  assert.strictEqual(isRiskyGapChange('incomplete:4:9', 'incomplete:4:6'), true);
});

test('an events-calendar page is rejected, a real review on the same host stays (BRO-4679)', () => {
  assert.strictEqual(classifyGapCandidateUrl('https://openingnight.online/crazy-mama-a-true-story-of-love-and-madness/').ok, false);
  assert.deepStrictEqual(classifyGapCandidateUrl('https://openingnight.online/the-invention-of-love/'), { ok: true, reason: null });
});

test('a flagged TheatreVibe news post no longer holds a review slot (BRO-4190)', () => {
  const { isStaleNonReviewSlot } = require('./review-slot-guards.js');
  const news = { url: 'https://theatrevibe.co.uk/2026/08/03/news-the-last-ship-stings-musical-theatre-royal-drury-lane-22nd-september-to-3rd-october-2026/', wrongProduction: true };
  assert.strictEqual(isStaleNonReviewSlot(news, 'https://theatrevibe.co.uk/2026/09/25/review-the-last-ship-theatre-royal-drury-lane-2026/'), true);
});

test('a show with no opening date still dates roundups by previews: older runs are prior (BRO-4190 The Last Ship at the Met)', () => {
  const { isCurrentRunRoundup } = require('./gap-reference-sources.js');
  const met = { openingDate: null, previewsStartDate: '2026-06-09' };
  assert.strictEqual(isCurrentRunRoundup('2020-01-24', met), false);
  assert.strictEqual(isCurrentRunRoundup('2014-10-26', met), false);
  assert.strictEqual(isCurrentRunRoundup('2026-06-10', met), true);
  // no upper bound without an opening: a late press night stays current
  assert.strictEqual(isCurrentRunRoundup('2026-11-01', met), true);
  assert.strictEqual(isCurrentRunRoundup('2020-01-24', { openingDate: null }), true);
  // a declared earlier run keeps its roundups (transfer with no opening date yet)
  const transfer = { openingDate: null, previewsStartDate: '2026-10-16', priorRuns: [{ openingDate: '2026-07-01', closingDate: '2026-08-30' }] };
  assert.strictEqual(isCurrentRunRoundup('2026-07-05', transfer), true);
  assert.strictEqual(isCurrentRunRoundup('2020-07-05', transfer), false);
});

test('an undated roundup is dated by its URL (BWW YYYYMMDD) when the page gives no publish date', () => {
  const { articleRunIdentity } = require('./gap-ingest-policy.js');
  const met = { id: 'the-last-ship-off-broadway-2026', title: 'The Last Ship', openingDate: null, previewsStartDate: '2026-06-09' };
  const old = 'https://www.broadwayworld.com/article/Review-Roundup-Stings-THE-LAST-SHIP-at-the-Ahmanson-in-Los-Angeles-What-Did-the-Critics-Think-20200124';
  assert.strictEqual(articleRunIdentity('<html></html>', met, old).priorRun, true);
  const cur = 'https://www.broadwayworld.com/off-broadway/article/Review-Roundup-THE-HOPE-THEORY-at-MCC-20261001';
  const hope = { id: 'the-hope-theory-off-broadway-2026', title: 'The Hope Theory', openingDate: '2026-09-28', previewsStartDate: '2026-09-10' };
  assert.strictEqual(articleRunIdentity('<html></html>', hope, cur).priorRun, false);
});
