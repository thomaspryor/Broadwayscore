// BRO-6804: the review-gap census must not call a show "incomplete" for rows that
// are not an owed review of that production. Real functions only (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const noise = require('./gap-census-noise.js');
const { censusVerdictFor } = require('./gap-audit-merge.js');
const { classifyTimeoutListingBlurb } = require('./timeout-capsule.js');
const { isUrlMonthBeforeRun } = require('./gap-ingest-policy.js');
const { classifyGapCandidateUrl } = require('./non-review-url-patterns.js');
const { titleTokens } = require('./show-title-tokens.js');

const ld = (o) => `<html><script type="application/ld+json">${JSON.stringify(o)}</script></html>`;
const OPEN = '2026-10-06';

test('Time Out: unauthored pre-opening Review JSON-LD is a listing blurb', () => {
  const html = ld({ '@type': 'Review', datePublished: '2026-09-01', dateModified: '2026-09-01' });
  assert.equal(classifyTimeoutListingBlurb({ html, openingDate: OPEN }).verdict, 'listing_blurb');
});
test('Time Out: an authored or rated review stays a review', () => {
  assert.equal(classifyTimeoutListingBlurb({ html: ld({ '@type': 'Review', author: { name: 'A' }, datePublished: '2026-09-01' }), openingDate: OPEN }).verdict, 'review');
  assert.equal(classifyTimeoutListingBlurb({ html: ld({ '@type': 'Review', reviewRating: { ratingValue: 4 }, datePublished: '2026-09-01' }), openingDate: OPEN }).verdict, 'review');
});
test('Time Out: post-opening unauthored, no JSON-LD, no opening date all stay unknown (fail open)', () => {
  assert.equal(classifyTimeoutListingBlurb({ html: ld({ '@type': 'Review', datePublished: '2026-10-20' }), openingDate: OPEN }).verdict, 'unknown');
  assert.equal(classifyTimeoutListingBlurb({ html: '<html></html>', openingDate: OPEN }).verdict, 'unknown');
  assert.equal(classifyTimeoutListingBlurb({ html: ld({ '@type': 'Review', datePublished: '2026-09-01' }) }).verdict, 'unknown');
});

test('vetTimeoutListingCandidates moves only blurbs, records them, fails open on fetch errors', async () => {
  const blurb = ld({ '@type': 'Review', datePublished: '2026-09-01', dateModified: '2026-09-01' });
  const real = ld({ '@type': 'Review', author: { name: 'Critic' }, datePublished: '2026-10-07' });
  const pages = {
    'https://www.timeout.com/london/theatre/a': blurb,
    'https://www.timeout.com/london/theatre/b': real,
  };
  const missing = [
    { url: 'https://www.timeout.com/london/theatre/a' },
    { url: 'https://www.timeout.com/london/theatre/b' },
    { url: 'https://www.timeout.com/london/theatre/c' },
    { url: 'https://www.timeout.com/london/theatre/d-review' },
    { url: 'https://example.com/x' },
  ];
  const fetched = [];
  const out = await noise.vetTimeoutListingCandidates(missing, { openingDate: OPEN }, {
    fetchPage: async (u) => { fetched.push(u); if (u.endsWith('/c')) throw new Error('boom'); return { content: pages[u] }; },
  });
  assert.deepEqual(out.nonReview.map((m) => m.url), ['https://www.timeout.com/london/theatre/a']);
  assert.equal(out.nonReview[0].nonReviewVerdict, 'timeout-listing-blurb');
  assert.deepEqual(out.missing.map((m) => m.url), missing.slice(1).map((m) => m.url));
  assert.ok(!fetched.includes('https://example.com/x') && !fetched.some((u) => u.endsWith('-review')));
});

test('tour candidates: page published long before the run is an earlier leg; undated or recent stays', async () => {
  const show = { category: 'tour', openingDate: '2026-10-15' };
  const pages = {
    'https://a.com/old': '"datePublished":"2026-05-13T19:41:30+00:00"',
    'https://a.com/new': '"datePublished":"2026-10-28T10:00:00+00:00"',
    'https://a.com/none': '<html></html>',
  };
  const missing = Object.keys(pages).map((url) => ({ url, serpCensus: true }));
  const out = await noise.vetTourCandidatesByPageDate(missing, show, { fetchPage: async (u) => ({ content: pages[u] }) });
  assert.deepEqual(out.nonReview.map((m) => m.url), ['https://a.com/old']);
  assert.equal(out.nonReview[0].nonReviewVerdict, 'page-date-before-run');
  assert.deepEqual(out.missing.map((m) => m.url), ['https://a.com/new', 'https://a.com/none']);
  // a non-tour show is never page-vetted
  const none = await noise.vetTourCandidatesByPageDate(missing, { category: 'broadway', openingDate: '2026-10-15' }, { fetchPage: async () => { throw new Error('no fetch'); } });
  assert.equal(none.nonReview.length, 0);
});

test('festival-named page on a non-UK, non-tour show is page-date vetted too (Edinburgh Fringe run before a New York opening)', async () => {
  const show = { category: 'off-broadway', openingDate: '2026-10-27', previewsStartDate: '2026-10-22' };
  const pages = {
    'https://r.com/edinburgh-fringe-review-roleplay': '<meta property="article:published_time" content="2026-08-14T09:00:00+00:00">',
    'https://r.com/roleplay-review': '<meta property="article:published_time" content="2026-08-14T09:00:00+00:00">',
  };
  const fetched = [];
  const missing = Object.keys(pages).map((url) => ({ url, serpCensus: true }));
  const out = await noise.vetTourCandidatesByPageDate(missing, show, { fetchPage: async (u) => { fetched.push(u); return { content: pages[u] }; } });
  assert.deepEqual(out.nonReview.map((m) => m.url), ['https://r.com/edinburgh-fringe-review-roleplay']);
  assert.deepEqual(fetched, ['https://r.com/edinburgh-fringe-review-roleplay']);
});

test('censusExclusionReason: flagged rows the audit already proved are excluded; bare rows are not', () => {
  const f = (o) => noise.censusExclusionReason({ url: 'https://x.com/a', host: 'x.com', ...o }, 'flagged');
  assert.equal(f({ confirmedNonReview: true }), 'confirmed-non-review');
  assert.equal(f({ copyOfLiveReview: true }), 'copy-of-live-review');
  assert.equal(f({ liveInReviews: true }), 'live-in-reviews');
  assert.equal(f({ exclusion: 'automatedExcluded' }), null, 'an automated exclusion stays a gap for a person');
  assert.equal(f({ exclusion: 'humanExcluded' }), 'collected-and-excluded');
  assert.equal(f({ exclusion: 'automatedExcluded', recoverable: true }), null);
  assert.equal(f({}), null);
});

test('missing rows: portals and URL-dated earlier-run hits leave the census; plain misses stay', () => {
  const show = { title: 'The Bodyguard', openingDate: '2026-10-15' };
  const m = (url, o = {}) => noise.missingNoiseReason({ url, serpCensus: true, ...o }, { show, tokensOf: titleTokens });
  assert.equal(m('https://uk.headtopics.com/news/a-review-89354393'), 'syndication-portal');
  assert.equal(m('https://www.yahoo.com/entertainment/review-x'), 'syndication-portal');
  assert.equal(m('https://jadar.uk/2026/01/20/review-the-bodyguard/'), 'url-date-before-run');
  assert.equal(m('https://www.blackgirlincle.com/2026/10/28/the-bodyguard-musical-tour-review/'), null);
  // aggregator-cited (not census-only) rows are vouched for
  assert.equal(noise.missingNoiseReason({ url: 'https://uk.headtopics.com/x' }, { show }), null);
});

test('single-word title: a slug reading as a longer title is a different show', () => {
  const show = { title: 'Girls' };
  const x = (u) => noise.titleExtendedInUrl(u, show, titleTokens);
  assert.equal(x('https://hollywrites.com/review-the-girls-phoenix-theatre/'), true);
  assert.equal(x('https://1minutecritic.com/school-girls-broadway-review/'), true);
  assert.equal(x('https://nytimes.com/2022/04/12/theater/to-my-girls-review.html'), true);
  assert.equal(x('https://example.com/girls-review-maria-theatre'), false);
  assert.equal(x('https://example.com/review-girls-maria-theatre'), false);
  // a folder before the slug is not part of the title
  assert.equal(x('https://unknown-news-site.example/en/girls-review/'), false);
  assert.equal(x('https://example.com/reviews/girls-at-the-maria'), false);
  // a multi-word title is untouched; the title's own words are not extensions
  assert.equal(noise.titleExtendedInUrl('https://e.com/the-girls', { title: 'Hadestown' }, titleTokens), false);
  for (const [u, title] of [
    ['https://variety.com/2026/x/denzel-washington-jake-gyllenhaal-othello-review', 'Othello'],
    ['https://theguardian.com/stage/a-thrilling-hamlet-review', 'Hamlet'],
    ['https://e.com/disneys-aladdin-review', 'Aladdin'],
    ['https://e.com/review-shakespeares-macbeth', 'Macbeth'],
  ]) assert.equal(noise.titleExtendedInUrl(u, { title }, titleTokens), false, u);
  assert.equal(noise.titleExtendedInUrl('https://e.com/oh-mary-review', { title: 'Oh, Mary!' }, titleTokens), false);
});

test('UK tour leg: only a North American tour, only UK places or .co.uk', () => {
  const tour = { category: 'tour', venue: 'North American Tour' };
  assert.equal(noise.ukTourLegUrl('https://ilovemanchester.com/review-bodyguard-palace-theatre', tour), true);
  assert.equal(noise.ukTourLegUrl('https://whatsonnewcastle.com/the-bodyguard-the-musical-review/', tour), true);
  assert.equal(noise.ukTourLegUrl('https://www.londontheatre1.com/reviews/the-bodyguard-2026-new-wimbledon-theatre-review/', tour), true);
  assert.equal(noise.ukTourLegUrl('https://www.blackgirlincle.com/2026/10/28/the-bodyguard-musical-tour-review/', tour), false);
  assert.equal(noise.ukTourLegUrl('https://ilovemanchester.com/review', { category: 'broadway' }), false);
});

test('isUrlMonthBeforeRun: one month of grace, fails open without a month or with priorRuns', () => {
  const s = { openingDate: '2026-10-15' };
  assert.equal(isUrlMonthBeforeRun('https://x.com/2026/08/a', s), true);
  assert.equal(isUrlMonthBeforeRun('https://x.com/2026/09/a', s), false);
  assert.equal(isUrlMonthBeforeRun('https://x.com/2026/10/a', s), false);
  assert.equal(isUrlMonthBeforeRun('https://x.com/a', s), false);
  assert.equal(isUrlMonthBeforeRun('https://x.com/2026/01/a', { ...s, priorRuns: [{}] }), false);
  assert.equal(isUrlMonthBeforeRun('https://x.com/2026/01/a', { ...s, previewsStartDate: '2026-01-20' }), false);
});

test('named non-review hosts the census returned for A Few Good Men / The Kick Inside', () => {
  const ok = (u) => classifyGapCandidateUrl(u).ok;
  for (const u of [
    'https://dev.arielpa.nyc/post/a-few-good-men-broadway-review-competent-but-unnecessary/',
    'https://news.frombroadway.com/post/review-roundup-a-few-good-men-vivian-beaumont-theater',
    'https://movies.rockstarmedia.com.my/news/few-good-men-broadway-review/',
    'https://www.cnn.com/2026/10/26/entertainment/video/aaron-sorkins-a-few-good-men',
    'https://www.goldderby.com/theater/2026/a-few-good-men-aaron-sorkin-bradley-whitford-broadway-revival/',
    'https://a2view.com/tag/the-bodyguard-tour/',
    'https://www.allmusic.com/album/the-kick-inside-mw0000',
    'https://pitchfork.com/reviews/albums/kate-bush-the-kick-inside/',
    'https://www.discogs.com/master/12345-kate-bush-the-kick-inside',
    'https://www.loudersound.com/features/kate-bush-the-kick-inside',
  ]) assert.equal(ok(u), false, u);
  // an ordinary outlet stays a candidate, and the Gold Derby rule names no review slug
  assert.notEqual(classifyGapCandidateUrl('https://www.goldderby.com/theater/2026/a-few-good-men-revival-reviews/').reason, 'awards-news-not-review');
  assert.equal(ok('https://www.nytimes.com/2026/10/26/theater/a-few-good-men-review.html'), true);
});

const row = (o) => ({ showId: 's', title: 'Girls', openingDate: '2026-10-27', aggregatorListedUrls: [], aggregatorArticles: [{}], missing: [], flaggedMisses: [], citedNoUrl: [], ...o });

test('censusVerdictFor: excluded rows no longer make a show incomplete, and are recorded', () => {
  const v = censusVerdictFor(row({
    aggregatorListedUrls: ['https://www.nytimes.com/2026/10/28/theater/girls-review.html'],
    flaggedMisses: [{ url: 'https://stagefright.com/a-review', host: 'stagefright.com', confirmedNonReview: true }, { url: 'https://y.com/b', host: 'y.com', exclusion: 'humanExcluded' }],
    missing: [{ url: 'https://uk.headtopics.com/n/1', host: 'uk.headtopics.com', serpCensus: true }],
    nonReviewCandidates: [{ url: 'https://www.timeout.com/london/theatre/g', host: 'timeout.com', nonReviewVerdict: 'timeout-listing-blurb' }],
  }));
  assert.equal(v.verdict, 'complete');
  assert.deepEqual(v.excluded.map((e) => e.reason).sort(), ['collected-and-excluded', 'confirmed-non-review', 'syndication-portal', 'timeout-listing-blurb']);
});

test('censusVerdictFor: a census of only excluded rows is no-census-yet, never a vacuous complete', () => {
  const v = censusVerdictFor(row({ flaggedMisses: [{ url: 'https://stagefright.com/a-review', host: 'stagefright.com', confirmedNonReview: true }] }));
  assert.equal(v.verdict, 'no-census-yet');
});

test('censusVerdictFor: a genuine miss still makes the show incomplete, recoverable flagged rows too', () => {
  const real = censusVerdictFor(row({ missing: [{ url: 'https://www.blackgirlincle.com/2026/10/28/the-bodyguard-musical-tour-review/', host: 'blackgirlincle.com', serpCensus: true }] }));
  assert.equal(real.verdict, 'incomplete');
  assert.equal(real.excluded.length, 0);
  const rec = censusVerdictFor(row({ flaggedMisses: [{ url: 'https://y.com/b', host: 'y.com', exclusion: 'automatedExcluded', recoverable: true }] }));
  assert.equal(rec.verdict, 'incomplete');
  const bare = censusVerdictFor(row({ flaggedMisses: [{ url: 'https://y.com/b', host: 'y.com' }] }));
  assert.equal(bare.verdict, 'incomplete');
});

test('ukTourLegUrl: US cities that share a UK name are not UK legs', () => {
  const tour = { category: 'tour', venue: 'North American tour' };
  assert.equal(noise.ukTourLegUrl('https://e.com/the-bodyguard-at-bjcc-birmingham-review', tour), false);
  assert.equal(noise.ukTourLegUrl('https://e.com/the-bodyguard-manchester-opera-house', tour), false);
  assert.equal(noise.ukTourLegUrl('https://e.com/the-bodyguard-wimbledon-review', tour), true);
});

test('vetting stops fetching once the run budget is exceeded and keeps the rest as candidates (BRO-6804)', async () => {
  let fetched = 0;
  const deps = { fetchPage: async () => { fetched++; return { content: '' }; } };
  const missing = [{ url: 'https://www.timeout.com/newyork/theater/a-show' }, { url: 'https://www.timeout.com/newyork/theater/b-show' }];
  const out = await noise.vetTimeoutListingCandidates(missing, { openingDate: '2026-10-01' }, deps, { exceeded: () => true });
  assert.equal(fetched, 0);
  assert.equal(out.missing.length, 2);
  assert.equal(out.nonReview.length, 0);
});

test('ukTourLegUrl survives a malformed percent-escape in the path', () => {
  assert.doesNotThrow(() => noise.ukTourLegUrl('https://e.com/%E0%A4%A', { category: 'tour', venue: 'North American tour' }));
});

test('BRO-5489: a UK-market show page-date vets every census candidate (Buffy Revamped: a 2025 tour-date piece before the 2026 Lyric run)', async () => {
  const show = { category: 'west-end', openingDate: null, previewsStartDate: '2026-10-12' };
  const pages = {
    'https://www.theatrereviewsnorth.com/post/buffy-revamped': '<meta property="article:published_time" content="2025-08-20T09:14:04.449Z"/>',
    'https://x.com/buffy-revamped-lyric-review': '"datePublished":"2026-10-13T08:00:00Z"',
    'https://x.com/undated': '<html></html>',
  };
  const missing = Object.keys(pages).map((url) => ({ url, serpCensus: true }));
  missing.push({ url: 'https://x.com/not-census', serpCensus: false });
  const fetched = [];
  const out = await noise.vetTourCandidatesByPageDate(missing, show, { fetchPage: async (u) => { fetched.push(u); return { content: pages[u] }; } });
  assert.deepEqual(out.nonReview.map((m) => m.url), ['https://www.theatrereviewsnorth.com/post/buffy-revamped']);
  assert.equal(out.nonReview[0].nonReviewDetail, '2025-08-20');
  assert.deepEqual(out.missing.map((m) => m.url), ['https://x.com/buffy-revamped-lyric-review', 'https://x.com/undated', 'https://x.com/not-census']);
  assert.ok(!fetched.includes('https://x.com/not-census'));
  for (const category of ['off-west-end', 'regional']) {
    const o = await noise.vetTourCandidatesByPageDate(missing, { ...show, category }, { fetchPage: async (u) => ({ content: pages[u] }) });
    assert.equal(o.nonReview.length, 1, category);
  }
});

// BRO-6968: The Bridge (Bush Theatre) census held Into the Woods / Guys and Dolls "at the Bridge Theatre".
test('a title used only as another house\'s name is not this show', () => {
  const show = { title: 'The Bridge', venue: 'Bush Theatre', category: 'off-west-end', openingDate: '2026-11-03' };
  const u = (url) => noise.titleOnlyAsOtherVenueInUrl(url, show, titleTokens);
  assert.equal(u('https://www.thetimes.com/culture/theatre-dance/article/into-the-woods-review-bridge-theatre-gzw6h6f8b'), true);
  assert.equal(u('https://www.timeout.com/london/news/review-into-the-woods-bridge-theatre-121125'), true);
  assert.equal(u('https://variety.com/2023/legit/reviews/guys-and-dolls-review-london-nicholas-hytner-bridge-theatre-1235553744/'), true);
  assert.equal(u('https://www.theguardian.com/culture/2026/aug/30/the-bridge-review-alaa-shehada'), false);
  assert.equal(u('https://www.bestoftheatre.co.uk/blog/post/review-roundup-the-bridge-bush-theatre'), false);
  assert.equal(u('https://www.timeout.com/london/theatre/the-bridge-4'), false);
  // SERP title/snippet: the noel-coward URL carried "bridge" only in its snippet.
  assert.equal(noise.titleOnlyAsOtherVenue('/article/into-woods-review-noel-coward-theatre Into the Woods review: the Bridge Theatre transfer', show, titleTokens), true);
  assert.equal(noise.titleOnlyAsOtherVenue('/stage/x The Bridge review, Bush Theatre', show, titleTokens), false);
  assert.equal(noise.missingNoiseReason({ url: 'https://www.timeout.com/london/news/review-into-the-woods-bridge-theatre-121125', serpCensus: true }, { show, tokensOf: titleTokens }), 'title-is-other-venue');
  // The title followed by the outlet's "theatre review" label is this show (review finding).
  assert.equal(u('https://x.com/the-bridge-theatre-review'), false);
  assert.equal(noise.titleOnlyAsOtherVenue('/stage/x The Bridge, theatre review: a quiet triumph', show, titleTokens), false);
  assert.equal(u('https://variety.com/2026/legit/reviews/into-the-woods-review-bridge-theater-1234/'), true);
  // Trade-off pinned: a "theatre review" label after the house keeps the row (an extra gap, never a hidden review).
  assert.equal(u('https://x.com/guys-and-dolls-at-the-bridge-theatre-review'), false);
  // Own house spelled "theater" by a US outlet stays this show's.
  assert.equal(noise.titleOnlyAsOtherVenueInUrl('https://variety.com/x-bridge-theater-1234', { title: 'Bridge', venue: 'Bridge Theatre', category: 'off-west-end' }, titleTokens), false);
  // A New York show's "theater" is its own spelling, never a London house.
  assert.equal(noise.titleOnlyAsOtherVenueInUrl('https://x.com/show-apollo-theater-harlem', { title: 'Apollo', venue: 'Booth Theatre', category: 'broadway' }, titleTokens), false);
  // A show whose own house carries the name keeps those reviews.
  const own = { title: 'Lyric', venue: 'Lyric Theatre', openingDate: '2026-11-03' };
  assert.equal(noise.titleOnlyAsOtherVenueInUrl('https://x.co.uk/lyric-lyric-theatre-review', own, titleTokens), false);
  assert.equal(noise.titleOnlyAsOtherVenueInUrl('https://x.co.uk/review-at-the-lyric-theatre', own, titleTokens), false);
});

test('a cross-show drop live under any other show is not owed here (BRO-6968)', () => {
  const ITW = 'https://www.timeout.com/london/news/review-into-the-woods-bridge-theatre-121125';
  const OWN = 'https://www.theguardian.com/culture/2026/aug/30/the-bridge-review-alaa-shehada';
  const drops = [{ url: ITW, matchedShowId: 'into-the-woods-2022' }, { url: OWN, matchedShowId: 'bridge-2019' }, { url: null }];
  const reviews = [{ showId: 'into-the-woods-off-west-end-2025', url: `${ITW}/` }, { showId: 'the-bridge-off-west-end-2026', url: OWN }];
  const canon = (u) => u.replace(/\/+$/, '');
  assert.deepEqual(noise.crossShowDropsOwedHere(drops, reviews, 'the-bridge-off-west-end-2026', canon).map((d) => d.url), [OWN]);
  const JC = 'https://www.thetimes.com/culture/theatre-dance/article/theatre-review-julius-caesar-bridge-theatre-david-morrissey-ben-whishaw-8f6fcfxnh';
  const show = { title: 'The Bridge', venue: 'Bush Theatre' };
  assert.deepEqual(noise.crossShowDropsOwedHere([{ url: JC }, { url: OWN }], [], 'the-bridge-off-west-end-2026', canon, { show, tokensOf: titleTokens }).map((d) => d.url), [OWN]);
  assert.equal(noise.crossShowDropsOwedHere([{ url: JC }], [], 'x', canon).length, 1);
});

// ---- BRO-7603: prior-production URLs and news pieces are not Downstate's missing reviews ----
const { tagUrlYearPriorRuns, ingestBlockReason } = require('./gap-ingest-policy.js');
const DS = { id: 'downstate-2026', title: 'Downstate', openingDate: '2026-11-15', previewsStartDate: '2026-10-22', category: 'play', market: 'broadway' };
const WAPO_2022 = 'https://www.washingtonpost.com/theater-dance/2022/11/23/downstate-bruce-norris-pedophiles/';
const DL_NEWS = ['https://deadline.com/downstate-broadway-scott-rudin-joe-mantello-1237062672', 'https://deadline.com/downstate-broadway-scott-rudin-barry-diller-1237070817'];
const NEWS_DAY = [
  'https://www.broadwaynews.com/bruce-norris-downstate-delays-first-broadway-preview-again-due-to-illness/',
  'https://www.theatermania.com/news/bruce-norriss-downstate-sets-broadway-premiere-with-k-todd-freeman-and-francis-guinan_1852625/',
  'https://frontmezzjunkies.com/2026/10/22/downstate-finally-arrives-on-broadway-tonight-and-im-ready-to-enter-that-difficult-house-again/',
];
const REAL_REVIEWS = [
  'https://deadline.com/2026/11/downstate-broadway-review-1237220229/',
  'https://www.theatermania.com/news/review-downstate-is-the-most-dangerous-play-on-broadway_1859448/',
  'https://deadline.com/2025/03/othello-broadway-denzel-washington-1236346453/', // a real Deadline review with no "review" in the slug
];

test('BRO-7603: tagUrlYearPriorRuns marks a pre-window URL priorRun even when a current article also cites it', () => {
  const rows = [{ url: WAPO_2022, sources: [{ source: 'aggregator-article' }, { source: 'aggregator-article' }] }, { url: REAL_REVIEWS[0] }];
  tagUrlYearPriorRuns(rows, DS);
  assert.equal(rows[0].priorRun, true);
  assert.equal(rows[0].priorRunSource, 'url-year-before-run');
  assert.notEqual(rows[1].priorRun, true);
  assert.ok(ingestBlockReason(rows[0], DS), 'a tagged row is ingest-blocked');
});
test('BRO-7603: tagUrlYearPriorRuns keeps a declared priorRuns year, a year-titled show, and an existing source', () => {
  const declared = { ...DS, priorRuns: [{ openingDate: '2022-10-01', closingDate: '2022-12-31', venue: 'Playwrights Horizons' }] };
  const r1 = [{ url: WAPO_2022 }];
  tagUrlYearPriorRuns(r1, declared);
  assert.notEqual(r1[0].priorRun, true, 'a declared priorRuns entry covering the year readmits the URL');
  const y = [{ url: 'https://www.nytimes.com/1984/11/20/theater/1984-review.html' }];
  tagUrlYearPriorRuns(y, { ...DS, title: '1984', openingDate: '2017-06-22', previewsStartDate: '2017-05-18' });
  assert.notEqual(y[0].priorRun, true, 'a title that is a year never self-blocks');
  const keep = [{ url: WAPO_2022, priorRun: true, priorRunSource: 'aggregator-article-date' }];
  tagUrlYearPriorRuns(keep, DS);
  assert.equal(keep[0].priorRunSource, 'aggregator-article-date');
});
test('BRO-7603: censusExclusionReason drops a pre-window URL from missing and flagged rows, any source', () => {
  const ctx = { show: DS };
  assert.equal(noise.censusExclusionReason({ url: WAPO_2022 }, 'missing', ctx), 'url-year-before-run');
  assert.equal(noise.censusExclusionReason({ url: WAPO_2022 }, 'flagged', ctx), 'url-year-before-run');
  assert.equal(noise.censusExclusionReason({ url: WAPO_2022 }, 'listed', ctx), 'url-year-before-run');
  assert.equal(noise.censusExclusionReason({ url: REAL_REVIEWS[0] }, 'missing', ctx), null);
});
test('BRO-7603: censusVerdictFor no longer counts a 2022 URL listed by a roundup as live, and Downstate reads complete', () => {
  const result = {
    showId: DS.id, title: DS.title, openingDate: DS.openingDate, previewsStartDate: DS.previewsStartDate,
    aggregatorArticles: ['https://playbill.com/x'],
    aggregatorListedUrls: [REAL_REVIEWS[0], 'https://www.vulture.com/2022/11/theater-review-bruce-norris-downstate-playwrights-horizons.html', 'https://www.nytimes.com/2022/11/15/theater/downstate-review.html'],
    missing: [{ url: WAPO_2022, host: 'washingtonpost.com', knownOutletId: 'washpost' }, ...DL_NEWS.map((url) => ({ url, host: 'deadline.com', knownOutletId: 'deadline', serpCensus: true })), ...NEWS_DAY.map((url) => ({ url, host: new URL(url).hostname.replace(/^www\./, '') }))],
    flaggedMisses: [], citedNoUrl: [],
  };
  const v = censusVerdictFor(result);
  assert.deepEqual(v.candidates.filter((c) => c.state === 'live').map((c) => c.url), [REAL_REVIEWS[0]]);
  assert.deepEqual(v.missing, [], `no false missing rows: ${JSON.stringify(v.missing)}`);
  assert.equal(v.verdict, 'complete');
  assert.ok(v.excluded.some((e) => e.url === WAPO_2022 && e.reason === 'url-year-before-run'), 'recorded, not silently dropped');
});
test('BRO-7603: a real missing current-run review still reads incomplete', () => {
  const v = censusVerdictFor({
    showId: DS.id, title: DS.title, openingDate: DS.openingDate, previewsStartDate: DS.previewsStartDate,
    aggregatorArticles: ['https://playbill.com/x'], aggregatorListedUrls: [],
    missing: [{ url: REAL_REVIEWS[0], host: 'deadline.com', knownOutletId: 'deadline' }, { url: REAL_REVIEWS[1], host: 'theatermania.com', knownOutletId: 'theatermania' }],
    flaggedMisses: [], citedNoUrl: [],
  });
  assert.equal(v.verdict, 'incomplete');
  assert.equal(v.missing.length, 2);
});
test('BRO-7603: classifyGapCandidateUrl refuses the Deadline/broadwaynews/theatermania/frontmezz news fixtures but keeps real reviews', () => {
  for (const u of [...DL_NEWS, ...NEWS_DAY]) assert.equal(classifyGapCandidateUrl(u).ok, false, u);
  for (const u of REAL_REVIEWS) assert.equal(classifyGapCandidateUrl(u).ok, true, u);
});

test('BRO-7603 ship-check: a year word in the slug is NOT a publish date (current-run reviews stay counted)', () => {
  const cases = [
    ['https://www.nysun.com/article/noel-cowards-1925-comedy-fallen-angels-soars-on-broadway', { ...DS, title: 'Fallen Angels', openingDate: '2026-04-01', previewsStartDate: '2026-03-10' }],
    ['https://example.com/review-a-strange-loop-returns-since-2019', { ...DS, title: 'A Strange Loop', openingDate: '2022-04-26', previewsStartDate: '2022-03-24' }],
    ['https://operawire.com/metropolitan-opera-2025-26-review-eugene-onegin/', { ...DS, title: 'Eugene Onegin', openingDate: '2026-02-01', previewsStartDate: null }],
  ];
  for (const [u, show] of cases) {
    const rows = [{ url: u }];
    tagUrlYearPriorRuns(rows, show);
    assert.notEqual(rows[0].priorRun, true, u);
    assert.equal(noise.censusExclusionReason({ url: u }, 'missing', { show }), null, u);
  }
});
test('BRO-7603 ship-check: an undated Deadline URL with "review" in the slug stays a candidate', () => {
  assert.equal(classifyGapCandidateUrl('https://deadline.com/downstate-broadway-review-1237220229').ok, true);
  assert.equal(classifyGapCandidateUrl(DL_NEWS[0]).ok, false);
});

// BRO-7621: Downstate (Booth, Broadway 2026) census listed the 2022 Playwrights Horizons review as missing.
const ny = require('./census-other-place.js');
const serp = (url) => ({ url, serpCensus: true });
test('census: "<title> at <another New York house>" (search-only row) is an earlier staging, not owed', () => {
  const show = { id: 'downstate-2026', title: 'Downstate', category: 'broadway', venue: 'Booth Theatre', openingDate: '2026-11-15' };
  const r = (row, s = show, kind = 'missing') => noise.censusExclusionReason(row, kind, { show: s, tokensOf: titleTokens });
  const PH = 'https://exeuntnyc.com/reviews/review-downstate-at-playwrights-horizons/';
  assert.equal(r(serp(PH)), 'url-other-ny-house');
  assert.equal(r(serp('https://example.com/downstate-at-the-public-theater-review')), 'url-other-ny-house');
  // An aggregator vouched for it, or it is a flagged row: not judged from the URL.
  assert.equal(r({ url: PH }), null);
  assert.equal(r(serp(PH), show, 'flagged'), null);
  // This production's own review keeps its row.
  assert.equal(r(serp('https://exeuntnyc.com/reviews/review-downstate-at-the-booth-theatre/')), null);
  // Only the last "at" places it: began at Playwrights Horizons, now at the Booth.
  assert.equal(r(serp('https://example.com/review-downstate-which-began-at-playwrights-horizons-lands-at-the-booth/')), null);
  // House named but not as "<title> at <house>".
  assert.equal(r(serp('https://example.com/playwrights-horizons-alum-reviews-downstate')), null);
  // The show plays at that house; no venue on file; declared prior runs; London.
  assert.equal(r(serp(PH), { ...show, category: 'off-broadway', venue: 'Playwrights Horizons' }), null);
  assert.equal(r(serp(PH), { ...show, venue: null }), null);
  assert.equal(r(serp(PH), { ...show, priorRuns: [{ venue: 'Playwrights Horizons' }] }), null);
  assert.equal(r(serp(PH), { ...show, category: 'west-end' }), null);
});

test("census: a company review at <company> for a show on that company own stage stays owed", () => {
  const own = (url, title, category, venue) => ny.urlNamesOtherNyHouse(url, { title, category, venue });
  // Reviewer-found false positives: live reviews of the right production.
  assert.equal(own('https://dcmetrotheaterarts.com/2018/03/29/review-lobby-hero-at-second-stage-theater/', 'Lobby Hero', 'broadway', 'Helen Hayes Theater'), null);
  assert.equal(own('https://exeuntnyc.com/reviews/review-laowang-a-chinatown-king-lear-at-primary-stages/', 'Laowang: A Chinatown King Lear', 'off-broadway', '59E59 Theater A'), null);
  assert.equal(own('https://exeuntnyc.com/reviews/review-the-saviors-at-atlantic-theater-company/', 'The Saviors', 'off-broadway', 'Atlantic Stage 2'), null);
  assert.equal(own('https://example.com/the-blood-quilt-at-lincoln-center-theater', 'The Blood Quilt', 'off-broadway', 'Mitzi E. Newhouse Theatre'), null);
  assert.equal(own('https://example.com/anon-a-tempest-at-mcc-theater', 'Anon(a)', 'off-broadway', 'The Newman Mills Theatre at the Robert W. Wilson MCC Theatre Space'), null);
  assert.equal(own('https://example.com/the-weir-at-the-irish-rep', 'The Weir', 'off-broadway', 'Irish Repertory Theatre'), null);
  assert.equal(own('https://example.com/review-much-ado-at-the-public', 'Much Ado About Nothing', 'off-broadway', 'Delacorte Theater'), null);
});
