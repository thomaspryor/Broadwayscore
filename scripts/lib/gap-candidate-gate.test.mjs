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
  'https://www.secrettheatre.com/shows-events/a-thousand-natural-shocks',
  'https://www.eventbrite.co.uk/e/home-girls-theatre-trip-watching-baby-tickets-2002959864874',
  'https://www.ticketgenie.com/8055661/begin-again-play-tickets.html',
  'https://www.expedia.com/event-tickets/event/begin-again-play-tickets-8055647',
  'https://www.headlong.co.uk/productions/fences',
  'https://stagebuddy.com/event/going-bacharach-the-songs-of-an-icon',
  'https://chiswickcalendar.co.uk/event/august-wilsons-fences-lyric-theatre/2026-10-12/',
  'https://www.britishtheatre.com/shows/deep-heat-rivalry',
  'https://didtheylikeit.com/shows/boop-the-musical/',
  'https://theatre.reviews/london-productions/harry-potter-cursed-child/',
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
  'https://stagebuddy.com/theater/theater-review/review-arcadia',
  'http://stagebuddy.com/reviews/review-white-rabbit-red-rabbit',
  'https://didtheylikeit.com/shows/the-wiz-bway/the-wiz-broadway-review-were-off-to-see-the-cheap-national-tour/',
  'https://chiswickcalendar.co.uk/darkling-bush-theatre-review/',
  'https://www.britishtheatre.com/review-cruise-duchess-theatre/',
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

test('a stored review dated well before this run marks its gap URL prior-run (BRO-4190 Met Macbeth 2008)', () => {
  const { isPublishDateBeforeRun } = require('./gap-ingest-policy.js');
  const macbeth = { openingDate: '2026-09-22', previewsStartDate: null };
  assert.strictEqual(isPublishDateBeforeRun('2008-05-09', macbeth), true);
  // first-night and pre-opening press inside the grace stay current
  assert.strictEqual(isPublishDateBeforeRun('2026-09-20', macbeth), false);
  assert.strictEqual(isPublishDateBeforeRun('2026-07-01', macbeth), false);
  // a transfer keeps its declared earlier run's reviews
  const transfer = { previewsStartDate: '2026-10-16', priorRuns: [{ openingDate: '2025-03-01', closingDate: '2025-04-30' }] };
  assert.strictEqual(isPublishDateBeforeRun('2025-03-05', transfer), false);
  assert.strictEqual(isPublishDateBeforeRun('2019-03-05', transfer), true);
  // no dates: no verdict
  assert.strictEqual(isPublishDateBeforeRun('2008-05-09', {}), false);
  assert.strictEqual(isPublishDateBeforeRun(null, macbeth), false);
});

test('a press-night cluster of early-dated stored reviews stays a gap (Grease immersive 2025 vs a 2026 record)', () => {
  const { pendingPriorRunUrls } = require('./gap-ingest-policy.js');
  const show = { previewsStartDate: '2026-07-22' };
  const cluster = [
    { url: 'https://www.theguardian.com/stage/2025/aug/06/grease-review', publishDate: '2025-08-06' },
    { url: 'https://www.thestage.co.uk/reviews/grease-review', publishDate: '2025-08-06' },
    { url: 'https://www.standard.co.uk/culture/theatre/grease-b1', publishDate: '2025-08-05' },
    { url: 'https://www.classicalsource.com/old-one/', publishDate: '2008-05-09' },
  ];
  assert.deepStrictEqual([...pendingPriorRunUrls(cluster, show).keys()], ['https://www.classicalsource.com/old-one/']);
  // two old reviews of one earlier run are still prior-run
  const two = cluster.slice(0, 2);
  assert.strictEqual(pendingPriorRunUrls(two, show).size, 2);
});

test('a press-night cluster 25 months before the run is the earlier production (BRO-5225 The Ask, Wild Project 2024)', () => {
  const { pendingPriorRunUrls } = require('./gap-ingest-policy.js');
  const show = { previewsStartDate: '2026-10-06', openingDate: '2026-10-13' };
  const cluster = [
    { url: 'https://www.theatrebeyondbroadway.com/reviews/the-ask', publishDate: '2024-09-08' },
    { url: 'https://exeuntnyc.com/reviews/review-the-ask-at-the-wild-project/', publishDate: '2024-09-13' },
    { url: 'https://www.theatrely.com/post/generations-collide-in-the-ask-review', publishDate: '2024-09-21' },
    { url: 'http://www.theaterscene.net/plays/offbway-plays/the-ask/tony-marinelli/', publishDate: '2024-09-13' },
  ];
  assert.strictEqual(pendingPriorRunUrls(cluster, show).size, 4);
  // boundary: 539d back stays a gap cluster, 541d back is prior-run
  const mk = (d) => ['a.com', 'b.com', 'c.com'].map((h) => ({ url: `https://${h}/r`, publishDate: d }));
  const s2 = { previewsStartDate: '2026-10-06' };
  assert.strictEqual(pendingPriorRunUrls(mk('2025-04-14'), s2).size, 0);
  assert.strictEqual(pendingPriorRunUrls(mk('2025-04-12'), s2).size, 3);
});

test('a roundup citing its own verdict with no link is not a missing review (BRO-4790 WET Last Ship)', () => {
  const { isRoundupSelfCitation } = require('./gap-ingest-policy.js');
  assert.strictEqual(isRoundupSelfCitation({ outletId: 'westendtheatre', outletName: 'WestendTheatre.com', source: 'westendtheatre' }), true);
  // London Box Office has standalone review pages: its self-citation stays a gap
  assert.strictEqual(isRoundupSelfCitation({ outletId: 'london-box-office', source: 'lbo-roundup' }), false);
  // another outlet cited by the same roundup is still a gap
  assert.strictEqual(isRoundupSelfCitation({ outletId: 'telegraph', source: 'lbo-roundup' }), false);
  assert.strictEqual(isRoundupSelfCitation({ outletId: 'financialtimes', source: 'westendtheatre' }), false);
  assert.strictEqual(isRoundupSelfCitation({ outletId: 'westendtheatre' }), false);
});

test('a stored date that disagrees with the year in the URL gives no prior-run verdict; kill switch', () => {
  const { pendingPriorRunUrls } = require('./gap-ingest-policy.js');
  const show = { previewsStartDate: '2026-09-25' };
  const misread = { url: 'https://newyorkclassicalreview.com/2026/10/alternate-cast-boheme/', publishDate: '2014-12-28' };
  const old = { url: 'https://www.nytimes.com/2016/10/15/theater/review-stuffed.html', publishDate: '2016-10-14' };
  assert.deepStrictEqual([...pendingPriorRunUrls([misread, old], show).keys()], [old.url]);
  process.env.GAP_PENDING_PRIOR_RUN_DISABLED = '1';
  try { assert.strictEqual(pendingPriorRunUrls([old], show).size, 0); } finally { delete process.env.GAP_PENDING_PRIOR_RUN_DISABLED; }
});

test('flagged wrongProduction files dated before the run are prior-run, press-night cluster included (Fish 2026 vs 2024 Theatre Row)', () => {
  const { flaggedFilePriorRunDate } = require('./gap-ingest-policy.js');
  const show = { previewsStartDate: '2026-09-26' };
  const old = { publishDate: 'April 2nd, 2024', wrongProduction: true };
  assert.strictEqual(flaggedFilePriorRunDate([old], show), 'April 2nd, 2024');
  assert.strictEqual(flaggedFilePriorRunDate([{ publishDate: '2026-10-12', wrongProduction: true }], show), null);
  assert.strictEqual(flaggedFilePriorRunDate([old, { publishDate: '2024-04-02' }], show), null);
  assert.strictEqual(flaggedFilePriorRunDate([{ wrongShow: true }], show), null);
  process.env.GAP_FLAGGED_PRIOR_RUN_DISABLED = '1';
  try { assert.strictEqual(flaggedFilePriorRunDate([old], show), null); } finally { delete process.env.GAP_FLAGGED_PRIOR_RUN_DISABLED; }
});

test('undated wrongProduction file with a high-confidence venue verdict is prior-run (BRO-5380 UNCONDITIONAL LA roundup)', () => {
  const { flaggedFilePriorRunDate } = require('./gap-ingest-policy.js');
  const show = { openingDate: '2026-10-15' };
  const cv = { wrongProduction: true, confidence: 'high', reviewedVenue: 'Skylight Theatre in Los Feliz' };
  assert.strictEqual(flaggedFilePriorRunDate([{ wrongProduction: true, contentVerification: cv }], show), 'venue-verified:Skylight Theatre in Los Feliz');
  assert.strictEqual(flaggedFilePriorRunDate([{ wrongProduction: true, contentVerification: { ...cv, confidence: 'low' } }], show), null);
  assert.strictEqual(flaggedFilePriorRunDate([{ wrongProduction: true }], show), null);
  assert.strictEqual(flaggedFilePriorRunDate([{ wrongProduction: true, contentVerification: cv }, { publishDate: '2026-10-16' }], show), null);
  // verifier names the record's OWN venue (tour-stop false positive): real review, stays a gap
  const own = { openingDate: '2026-10-15', venue: 'La MaMa / The Club' };
  assert.strictEqual(flaggedFilePriorRunDate([{ wrongProduction: true, contentVerification: { ...cv, reviewedVenue: 'La MaMa' } }], own), null);
  // dated after opening but venue-verified: label is the venue, not the date
  assert.strictEqual(flaggedFilePriorRunDate([{ wrongProduction: true, publishDate: '2026-10-16', contentVerification: cv }], show), 'venue-verified:Skylight Theatre in Los Feliz');
  assert.strictEqual(flaggedFilePriorRunDate([{ wrongShow: true, contentVerification: cv }], show), null);
});
