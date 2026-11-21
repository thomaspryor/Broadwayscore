// BRO-5081 review fact-check: the classes the sourced audit found, each pinned
// to the real function that now handles it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chooseCanonical, isWebSearchByline } = require('../../scripts/fix-circular-duplicate-pairs.js');
const { extractScore, HOST_GATED_STAR_OUTLETS } = require('../../scripts/lib/score-extractors.js');
const { isCandidate, alternateUrls, STARLESS_TEXT_SOURCES } = require('../../scripts/backfill-html-only-ratings.js');
const { ratingBand, quoteOnPage, judgeVote, norm } = require('../../scripts/review-factcheck/vote.js');
const { compareByline, pageIsAboutShow, judgeDate } = require('../../scripts/review-factcheck/sweep-web-search-bylines.js');
const { cleanByline } = require('../../scripts/review-factcheck/make-byline-fix-plans.js');

// --- d. critic byline: web-search-invented byline must not win a same-url pair
const url = 'https://www.timeout.com/newyork/theater/what-the-constitution-means-to-me-broadway-review-heidi-schreck';
const phantom = { outletId: 'timeout', criticName: 'Adam Feldman', url, source: 'web-search', sources: ['web-search'], assignedScore: 86, publishDate: 'March 14, 2019', fullText: 'There is a sense of rightness about this play.' };
const real = { outletId: 'timeout', criticName: 'Helen Shaw', url, source: 'bww-reviews', sources: ['bww-reviews', 'show-score'], assignedScore: 98, publishDate: 'March 31st, 2019', fullText: 'There is a sense of rightness about this play.' };

test('web-search byline loses to an aggregator-sourced byline on the same url (Time Out, What the Constitution Means to Me)', () => {
  const c = chooseCanonical('timeout--adam-feldman.json', phantom, 'timeout--helen-shaw.json', real);
  assert.equal(c.canonical, 'timeout--helen-shaw.json');
  assert.match(c.reason, /web-search/);
  const flipped = chooseCanonical('timeout--helen-shaw.json', real, 'timeout--adam-feldman.json', phantom);
  assert.equal(flipped.canonical, 'timeout--helen-shaw.json');
});

test('provenance rule only judges the creating source; later-merged aggregator sources do not vouch for a web-search name', () => {
  assert.equal(isWebSearchByline({ source: 'web-search', sources: ['web-search', 'dtli', 'show-score'] }), true);
  assert.equal(isWebSearchByline({ source: 'dtli', sources: ['web-search', 'dtli'] }), false);
});

test('two web-search records still fall through to the older rules', () => {
  const a = { ...phantom }; const b = { ...phantom, criticName: 'Sara Holdren' };
  const c = chooseCanonical('timeout--adam-feldman.json', a, 'timeout--sara-holdren.json', b);
  assert.doesNotMatch(c.reason, /web-search/);
});

// --- f. printed stars: Observer multi-show columns and BritishTheatre.com
const observerColumn = `<html><head><link rel="canonical" href="https://www.theguardian.com/stage/2025/feb/09/the-week-in-theatre-oedipus-elektra"></head>
<body><h1>The week in theatre: Oedipus; Elektra</h1><p>Body of the column.</p>
<p><strong>Star ratings (out of five)</strong><br>Oedipus <span>★★★</span><br>Elektra <span>★★</span></p>
<p>Oedipus is at the Old Vic, London, until 29 March</p></body></html>`;

test('Observer column: each show gets the rating printed next to its own title', () => {
  assert.equal(extractScore(observerColumn, '', 'observer', 'Elektra').originalScore, '2/5 stars');
  assert.equal(extractScore(observerColumn, '', 'observer', 'Oedipus').originalScore, '3/5 stars');
});

test('Observer column: a show not in the list gets no rating (never the first group)', () => {
  assert.equal(extractScore(observerColumn, '', 'observer', 'Hamlet'), null);
});

test('New York Observer pages (observer.com) are never rated', () => {
  const nyo = '<html><head><link rel="canonical" href="https://observer.com/2019/11/a-christmas-carol-review/"></head><body><p>★★★★ stars from a reader</p></body></html>';
  assert.equal(extractScore(nyo, '', 'observer', 'A Christmas Carol'), null);
});

test('BritishTheatre.com header rating is read; britishtheatreguide.info (same outletId) is not', () => {
  const bt = '<html><head><link rel="canonical" href="https://www.britishtheatre.com/posts/review-x"></head><body><p><strong>When We Have Sufficiently Tortured Each Other.</strong></p><p>National Theatre.</p><p>24 January 2019 </p><p>2 Stars </p><p>Text.</p></body></html>';
  assert.equal(extractScore(bt, '', 'british-theatre', 'When We Have Sufficiently Tortured Each Other').originalScore, '2/5 stars');
  const btg = '<html><head><link rel="canonical" href="https://www.britishtheatreguide.info/reviews/x"></head><body><p>3 Stars</p></body></html>';
  assert.equal(extractScore(btg, '', 'british-theatre', 'X'), null);
  assert.ok(HOST_GATED_STAR_OUTLETS.has('british-theatre'));
});

test('star backfill: Theatre Record texts are candidates; collector-fetched records are not', () => {
  assert.ok(STARLESS_TEXT_SOURCES.has('theatre-record'));
  const show = { id: 'more-life-west-end-2025', title: 'More Life', market: 'west-end', category: 'west-end', status: 'closed', openingDate: '2025-02-11', closingDate: '2025-03-15', venue: 'Royal Court' };
  const tr = { showId: show.id, outletId: 'timeout-london', outlet: 'Time Out London', criticName: 'Andrzej Lukowski', url: 'https://www.timeout.com/london/theatre/more-life-review', publishDate: '2025-02-12', source: 'theatre-record', contentTier: 'complete', fullText: 'x'.repeat(2000), assignedScore: 75, llmScore: { score: 75 } };
  const fetched = { ...tr, source: 'bww-roundup', fetchMethod: 'playwright' };
  assert.equal(isCandidate(fetched, show, '/tmp/x/timeout-london--andrzej-lukowski.json'), false);
  assert.equal(isCandidate({ ...tr, originalScore: '3/5' }, show, '/tmp/x/a.json'), false);
  assert.equal(isCandidate({ ...tr, outletId: 'nytimes' }, show, '/tmp/x/a.json'), false);
});

test('britishtheatre.com old review urls map to their /posts/ home', () => {
  assert.deepEqual(alternateUrls('https://britishtheatre.com/review-joe-egg-trafalgar-studios/'), ['https://www.britishtheatre.com/posts/review-joe-egg-trafalgar-studios']);
  assert.deepEqual(alternateUrls('https://www.timeout.com/london/theatre/x'), []);
});

// --- audit machinery: citations must hold, bands follow CLAUDE.md
test('rating bands match CLAUDE.md (2/5 31-50, 3/5 51-70, 4/5 71-90, 5/5 91-100)', () => {
  assert.deepEqual(ratingBand('2/5'), [31, 50]);
  assert.deepEqual(ratingBand('3 out of 5 stars'), [51, 70]);
  assert.deepEqual(ratingBand('★★★★'), [71, 90]);
  assert.deepEqual(ratingBand('5 stars'), [91, 100]);
  assert.deepEqual(ratingBand('3.5/4'), [71, 90]);
  assert.equal(ratingBand('B+'), null);
});

test('a checker vote counts only when its quote is on the page', () => {
  const page = { text: 'The show is a triumph of staging and a mess of plotting.', meta: { siteName: 'The Hollywood Reporter' } };
  assert.equal(quoteOnPage('a triumph of staging and a mess', norm(page.text)), true);
  assert.equal(judgeVote({ answer: 'yes', evidence: 'a triumph of staging and a mess', citation: 'snapshot' }, page, [], 'https://variety.com/x').counted, true);
  assert.equal(judgeVote({ answer: 'yes', evidence: 'an invented line about the show', citation: 'snapshot' }, page, [], 'https://variety.com/x').counted, false);
  assert.equal(judgeVote({ answer: 'yes', evidence: 'siteName: The Hollywood Reporter', citation: 'snapshot' }, page, [], 'https://variety.com/x').counted, true);
  assert.equal(judgeVote({ answer: 'yes', evidence: 'a triumph of staging and a mess', citation: '' }, page, [], 'https://variety.com/x').counted, false);
});

test('byline sweep: surname match, different name, off-topic page', () => {
  assert.equal(compareByline('David Rooney', ['David Rooney']), 'match');
  assert.equal(compareByline('Charles Isherwood', ['David Rooney']), 'different');
  assert.equal(compareByline('David Rooney', ['Variety Staff']), 'unknown');
  assert.equal(pageIsAboutShow('Met Ball fashion: who wore Fendi', 'https://www.hollywoodreporter.com/lifestyle/arts/american-buffalo-broadway-review', 'Glengarry Glen Ross'), false);
  assert.equal(pageIsAboutShow('Equus - Variety', 'https://variety.com/2008/legit/reviews/equus-1200472325/', 'Equus'), true);
});

test('fix plans only take one clean person name from the page', () => {
  assert.equal(cleanByline('By Robert Hofler'), 'Robert Hofler');
  assert.equal(cleanByline('Daniel D&#039;Addario'), "Daniel D'Addario");
  assert.equal(cleanByline('The Associated Press'), null);
  assert.equal(cleanByline('Tim Teeman and Brooke Leigh Howard'), null);
  assert.equal(cleanByline('Guardian stage'), null);
});

test('page dates only correct ours when they sit near opening night (CMS migration stamps never count)', () => {
  assert.equal(judgeDate('April 4, 2010', '2010-03-04', '2010-03-04', 'match'), 'wrong');
  assert.equal(judgeDate('April 20, 2011', '2018-08-19', '2011-04-20', 'match'), 'unknown');
  assert.equal(judgeDate('June 22, 2017', '2017-06-23', '2017-06-22', 'match'), 'ok');
  assert.equal(judgeDate('June 22, 2017', '2017-06-23', '2017-06-22', 'unreachable'), 'n/a');
});

// --- review findings (code-review on the first revision)
test('Observer column: a title that is only the end of another listed title gets nothing', () => {
  const col = '<html><head><link rel=canonical href=https://www.theguardian.com/stage/2024/x></head><body><p>Star ratings (out of five) Lady Macbeth ★★ Hamlet ★★★★</p></body></html>';
  assert.equal(extractScore(col, '', 'observer', 'Macbeth'), null);
  assert.equal(extractScore(col, '', 'observer', 'Hamlet').originalScore, '4/5 stars');
});

test('Observer column: "Lady Macbeth" never lends its stars to "Macbeth"', () => {
  const col = '<html><head><link rel="canonical" href="https://www.theguardian.com/stage/2024/x"></head><body><p>Star ratings (out of five) Lady Macbeth ★★ Macbeth ★★★★</p></body></html>';
  assert.equal(extractScore(col, '', 'observer', 'Macbeth').originalScore, '4/5 stars');
  assert.equal(extractScore(col, '', 'observer', 'Lady Macbeth').originalScore, '2/5 stars');
});

test('host gate reads the page canonical, not any mention of theguardian.com', () => {
  const nyo = '<html><head><link rel="canonical" href="https://observer.com/2019/11/x/"></head><body><a href="https://www.theguardian.com/stage">Guardian</a><script type="application/ld+json">{"ratingValue": "4"}</script></body></html>';
  assert.equal(extractScore(nyo, '', 'observer', 'X'), null);
});

test('rating bands read glyphs with empty stars', () => {
  assert.deepEqual(ratingBand('★★★☆☆'), [51, 70]);
  assert.deepEqual(ratingBand('★★★★½'), [91, 100]);
  assert.deepEqual(ratingBand('★★★☆'), [71, 90]);
  assert.deepEqual(ratingBand('★★★★★☆'), [71, 90]);
});

test("rule 2c' never demotes a web-search byline the article text prints", () => {
  // Mentioned without a byline marker, so rule 2c cannot settle it and 2c' runs.
  const text = 'As Ben Brantley once wrote of the original, the show is a delight.';
  const web = { outletId: 'nytimes', criticName: 'Ben Brantley', url: 'u', source: 'web-search', assignedScore: 80, fullText: text };
  const agg = { outletId: 'nytimes', criticName: 'Noel Murray', url: 'u', source: 'bww-roundup', assignedScore: 80, fullText: text };
  const c = chooseCanonical('nytimes--ben-brantley.json', web, 'nytimes--noel-murray.json', agg);
  assert.equal(c.canonical, 'nytimes--ben-brantley.json');
});

test('rule 2c\' is about the legacy web-search step only (SERP sources read the page byline)', () => {
  assert.equal(isWebSearchByline({ source: 'serp-discovery' }), false);
});

test('a citation to an unrelated domain never counts, even if the tool also opened the review', () => {
  const page = { text: 'Unrelated text.', meta: {} };
  const v = judgeVote({ answer: 'yes', evidence: 'quote only on the fan blog page', citation: 'https://fanblog.example/post' }, page, ['https://fanblog.example/post', 'https://variety.com/x'], 'https://variety.com/x');
  assert.equal(v.counted, false);
});

test('star backfill skips a page it already read with no rating (30-day marker), so batched runs progress', () => {
  const show = { id: 'x', title: 'X', market: 'west-end', category: 'west-end', status: 'closed', openingDate: '2025-02-11' };
  const d = { outletId: 'timeout-london', criticName: 'A B', url: 'https://www.timeout.com/london/theatre/x', source: 'theatre-record', starHtmlCheckedAt: new Date().toISOString() };
  assert.equal(isCandidate(d, show, '/tmp/x/a.json'), false);
});
