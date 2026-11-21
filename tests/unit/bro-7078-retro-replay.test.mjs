// LIVE-DATA-LANE: reads data/shows.json (untracked core data; content-filters numbered titles, gather-reviews); data/review-texts (untracked core data, module roots). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7078 opening retro (2026-11-20 recheck): replays each card's ORIGINAL bad
// input against the real guard functions, and covers the two fixes landed on
// this pass: the NYTG old-format suffix year (BRO-5545) and film/TV section
// site-search noise that became no-byline _pending stubs. Every function is
// require()d from its real module (CLAUDE.md section 15); no data files are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { offTopicSectionReason } = require('../../scripts/lib/non-review-url-patterns.js');
const { nytgSuffixYear, curtainupSuffixYear, isUrlYearOutsideWindow } = require('../../scripts/lib/content-filters.js');
const { urlYearOf } = require('../../scripts/lib/url-discovery.js');

// --- BRO-5545: Playbill Verdict listed NYTG's 2016 New York review for the 2026 off-West End Stuffed ---
const STUFFED = 'http://www.newyorktheatreguide.com/reviews/stuffed16.htm';

test('BRO-5545: the NYTG old-format suffix year is read, so the 2016 page is outside the 2026 window', () => {
  assert.equal(nytgSuffixYear(STUFFED), 2016);
  assert.equal(isUrlYearOutsideWindow(STUFFED, 2026, null), true);
  assert.equal(urlYearOf(STUFFED), 2016);
});

test('BRO-5545: in-window NYTG old pages and current NYTG slugs are untouched', () => {
  // Real reviews.json rows in the old form, each inside its show's window.
  assert.equal(isUrlYearOutsideWindow('https://www.newyorktheatreguide.com/reviews/vietgone16.htm', 2016, 2016), false);
  assert.equal(isUrlYearOutsideWindow('https://www.newyorktheatreguide.com/reviews/john15.htm', 2015, 2015), false);
  // Current slug form never carries a suffix year.
  assert.equal(nytgSuffixYear('https://www.newyorktheatreguide.com/reviews/1776-broadway-review'), null);
  assert.equal(nytgSuffixYear('https://www.newyorktheatreguide.com/reviews/2-22-a-ghost-story-off-broadway-review'), null);
  // Numbered titles are not years (shared rule with CurtainUp).
  assert.equal(nytgSuffixYear('https://www.newyorktheatreguide.com/reviews/catch22.htm'), null);
  // Other hosts are not read by the NYTG rule; CurtainUp keeps its own.
  assert.equal(nytgSuffixYear('https://www.curtainup.com/visitwtf14.html'), null);
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/visitwtf14.html'), 2014);
  assert.equal(nytgSuffixYear('not a url'), null);
});

// --- Pending noise: film/TV section hits filed as no-byline _pending stubs ---
const NOISE = [
  'https://www.hollywoodreporter.com/tv/tv-reviews/outlander-blood-of-my-blood-review-starz-1236339779/',
  'https://www.hollywoodreporter.com/movies/movie-reviews/lin-manuel-mirandas-in-the-heights-1234955500/',
  'https://www.hollywoodreporter.com/movies/movie-news/ray-nicholson-scared-tell-dad-jack-nicholson-acting-1236754341/',
  'https://www.thewrap.com/creative-content/movies/girls-will-be-girls-review/',
];
const REAL = [
  // THR filed its 2009-2012 theater reviews under /movies/movie-reviews/.
  'https://www.hollywoodreporter.com/movies/movie-reviews/night-music-theater-review-93806/',
  'https://www.hollywoodreporter.com/movies/movie-news/good-people-theater-review-163890/',
  // A real 2012 review in /tv/tv-news/ (Scandalous) is not covered.
  'https://www.hollywoodreporter.com/tv/tv-news/kathie-lee-giffords-scandalous-review-393527/',
  'https://www.thewrap.com/vanya-off-broadway-review-andrew-scott',
  'https://www.hollywoodreporter.com/lifestyle/arts/a-few-good-men-broadway-review-1236400000/',
];

test('pending noise: THR / TheWrap film and TV sections are off-topic; theatre slugs are not', () => {
  for (const u of NOISE) assert.equal(offTopicSectionReason(u), 'off-topic-section', u);
  for (const u of REAL) assert.equal(offTopicSectionReason(u), null, u);
});

test('pending noise: site search drops film/TV section hits before they are written', async (t) => {
  const { searchOutletSite, SITE_SEARCH_ENDPOINTS } = require('../../scripts/lib/site-search-discovery.js');
  const original = SITE_SEARCH_ENDPOINTS['hollywood-reporter'];
  t.after(() => { SITE_SEARCH_ENDPOINTS['hollywood-reporter'] = original; });
  const review = 'https://www.hollywoodreporter.com/lifestyle/arts/blood-of-my-blood-theater-review-1236800000/';
  SITE_SEARCH_ENDPOINTS['hollywood-reporter'] = {
    ...original, freeWp: undefined, requiresJs: false, skipUrlFilter: true,
    fetchAndParse: async () => [NOISE[0], { url: review }],
  };
  const urls = (await searchOutletSite('hollywood-reporter', 'Blood of my Blood')).map(r => r.url);
  assert.deepEqual(urls, [review]);
});

test('pending noise: replay skips an off-topic _pending stub without a fetch or an alert', async (t) => {
  const replay = require('../../scripts/replay-pending-bylines.js');
  const SHOW = { id: 'zz-bro7078-noise-west-end-2026', title: 'Blood of my Blood', openingDate: '2026-11-01', category: 'west-end', status: 'open' };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7078-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '_pending', SHOW.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hollywood-reporter--1a2b3c4d.json');
  fs.writeFileSync(file, JSON.stringify({ showId: SHOW.id, outletId: 'hollywood-reporter', criticName: 'Unknown', url: NOISE[0], fullText: null, source: 'site-search', pendingReason: 'no-byline' }));
  const calls = { fetch: 0, alert: 0, emit: 0, resolve: 0 };
  const deps = {
    root, show: SHOW, explicitScope: true, now: () => new Date('2026-11-02T12:00:00Z'),
    budget: { exceeded: () => false, minutes: 0 },
    fetch: async () => { calls.fetch++; throw new Error('must not fetch'); },
    alert: async () => { calls.alert++; }, emit: () => { calls.emit++; }, resolve: () => { calls.resolve++; },
  };
  const dry = await replay.processShow(SHOW.id, { ...deps, dryRun: true });
  assert.equal(dry.unrecoverable, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).promoteSkippedReason, undefined, 'dry run writes nothing');
  const r = await replay.processShow(SHOW.id, { ...deps, dryRun: false });
  assert.equal(r.unrecoverable, 0);
  assert.equal(r.kept, 1);
  assert.equal(calls.fetch + calls.alert + calls.emit, 0);
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).promoteSkippedReason, /^off-topic-section URL/);
});

test('pending noise: gather-reviews does not route an off-topic URL to _pending; a real no-byline hit still goes there', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7078-gather-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const show = 'zz-bro7078-gather-west-end-2026';
  const script = `
    const g = require(${JSON.stringify(path.resolve('scripts/gather-reviews.js'))});
    const base = { outletId: 'hollywood-reporter', outlet: 'The Hollywood Reporter', criticName: 'Unknown', source: 'site-search' };
    const off = g.createReviewFile(${JSON.stringify(show)}, { ...base, url: ${JSON.stringify(NOISE[0])} });
    const real = g.createReviewFile(${JSON.stringify(show)}, { ...base, url: 'https://www.hollywoodreporter.com/lifestyle/arts/blood-of-my-blood-theater-review-1236800000/' });
    process.stdout.write(JSON.stringify({ off, real }));`;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, REVIEW_TEXTS_DIR: root }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out, { off: false, real: true });
  const files = fs.readdirSync(path.join(root, '_pending', show));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '_pending', show, files[0]), 'utf8')).url.includes('/lifestyle/arts/'), true);
});

// --- Original inputs of cards whose guards are older (replay: holds) ---
test('BRO-6321 / BRO-5696: celebrity-baby RSS news is not the show Baby', () => {
  const { rssStubIdentityOk } = require('../../scripts/lib/rss-discovery.js');
  for (const url of [
    'https://www.nbcnewyork.com/entertainment/entertainment-news/tyler-cameron-fiancee-tate-madden-baby-dwts-dedication-night-routine/6561611/',
    'https://www.nbcnewyork.com/entertainment/entertainment-news/hilary-swank-pregnancy-age-52-addresses-backlash/6560204/',
  ]) assert.equal(rssStubIdentityOk({ url }, 'Baby'), false, url);
});

test('BRO-6320 / BRO-5759: undated, body-less The Stage stubs are parked', () => {
  const { evaluateUndatedStageStub } = require('../../scripts/lib/undated-stage-stub-guard.js');
  for (const url of [
    'https://www.thestage.co.uk/reviews/bull',
    'https://www.thestage.co.uk/reviews/dirty-dancing--the-classic-story-on-stage-review-at-churchill-theatre-bromley--lazy-and-unimaginative',
  ]) assert.equal(evaluateUndatedStageStub({ outletId: 'thestage', url }).park, true, url);
});

test('BRO-5790: Talkin\' Broadway Minneapolis page is US-side for the RSC As You Like It', () => {
  const { urlPathOppositeMarketIndicator, urlPathGuardTreatsShowAsUk } = require('../../scripts/lib/cross-market-guard.js');
  assert.equal(urlPathGuardTreatsShowAsUk('regional', 'Royal Shakespeare Theatre, Stratford-upon-Avon'), true);
  assert.equal(urlPathOppositeMarketIndicator({ urlPath: '/page/regional/minn/minn1539.html', oppositeMarket: 'us', showTitle: 'As You Like It' }), true);
});

test('BRO-4962 / BRO-4195: All That Chat thread URLs are forum links, not review pages', () => {
  const { isForumThreadUrl } = require('../../scripts/lib/talkinbroadway-forum-link.js');
  assert.equal(isForumThreadUrl('https://www.talkinbroadway.com/allthatchat_new/d.php?id=2654389'), true);
  assert.equal(isForumThreadUrl('https://www.talkinbroadway.com/allthatchat_new/d.php?id=2653913'), true);
  assert.equal(isForumThreadUrl('https://www.talkinbroadway.com/page/ny/2026/cosi.html'), false);
});

test('BRO-7027: the Times politics story is off-topic for "The Bridge"', () => {
  assert.equal(offTopicSectionReason('https://www.thetimes.com/uk/politics/article/city-bridge-foundation-grant-money-hamas-linked-organisation-j5sbhgrs2'), 'off-topic-section');
});
