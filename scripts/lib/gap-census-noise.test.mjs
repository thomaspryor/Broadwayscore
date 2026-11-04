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
  // A show whose own house carries the name keeps those reviews.
  const own = { title: 'Lyric', venue: 'Lyric Theatre', openingDate: '2026-11-03' };
  assert.equal(noise.titleOnlyAsOtherVenueInUrl('https://x.co.uk/lyric-lyric-theatre-review', own, titleTokens), false);
  assert.equal(noise.titleOnlyAsOtherVenueInUrl('https://x.co.uk/review-at-the-lyric-theatre', own, titleTokens), false);
});
