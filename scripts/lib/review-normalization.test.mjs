// BRO-2717: URL-aware junk detection — listing/PR/venue URLs must not become outletIds.
import './shows-json-empty-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyJunkOutletForUrl, isJunkOutlet, resolveSplitOutletByCritic } = require('./review-normalization.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');

test('name-only isJunkOutlet misses the treadmill outlets (premise)', () => {
  assert.equal(isJunkOutlet('southbank'), false);
  assert.equal(isJunkOutlet('spincyclenyc'), false);
});

test('unregistered outlet on listing / PR / venue URLs is junk', () => {
  for (const [id, url] of [
    ['southbank', 'https://southbank.london/whats-on/dog-man-the-musical'],
    ['spincyclenyc', 'https://www.spincyclenyc.com/index.php/theater/823-bathroom-attendant'],
    ['newvenue', 'https://newvenue.example/whats-on/some-show/'],
    ['someticketer', 'https://someticketer.example/some-musical-tickets'],
  ]) {
    const r = classifyJunkOutletForUrl(id, url, { outletKnown: false });
    assert.equal(r.junk, true, url);
  }
});

test('real review URLs and registered outlets are not junk', () => {
  assert.equal(classifyJunkOutletForUrl('timboatswain', 'https://timboatswain.example/2026/10/review-of-hamlet', { outletKnown: false }).junk, false);
  assert.equal(classifyJunkOutletForUrl('nytimes', 'https://www.nytimes.com/2026/10/01/theater/hamlet-review.html', { outletKnown: false }).junk, false);
  assert.equal(classifyJunkOutletForUrl('somevenue', 'https://x.example/whats-on/y', { outletKnown: true }).junk, false);
  assert.equal(classifyJunkOutletForUrl('unknown', 'https://x.example/review', { outletKnown: true }).junk, true);
});

test('writer refuses unregistered outlet on a listing URL from any source, allows escape hatch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2717-'));
  try {
    const url = 'https://brandnewvenue.example/whats-on/dog-man-the-musical';
    const r = createOrMergeReviewFile('dog-man-west-end-2026', {
      outletId: 'brandnewvenue', outlet: 'brandnewvenue', criticName: 'Unknown', url, source: 'gather-reviews',
      fields: { fullText: 'A review. '.repeat(80) },
    }, { reviewTextsDir: dir });
    assert.equal(r.guardRefused, true);
    assert.match(r.reason, /^unregistered-outlet-non-review-url/);
    assert.equal(fs.existsSync(path.join(dir, 'dog-man-west-end-2026')), false);
    const r2 = createOrMergeReviewFile('dog-man-west-end-2026', {
      outletId: 'brandnewvenue', outlet: 'brandnewvenue', criticName: 'Unknown', url, source: 'gather-reviews',
      fields: { fullText: 'A review. '.repeat(80), allowNonReviewUrl: true },
    }, { reviewTextsDir: dir });
    assert.doesNotMatch(String(r2.reason || ''), /unregistered-outlet-non-review-url/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writer leaves aggregator-sourced writes, existing-file merges and bare hosts alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2717b-'));
  const show = 'dog-man-west-end-2026';
  const w = (outletId, url, source) => createOrMergeReviewFile(show, {
    outletId, outlet: outletId, criticName: 'Unknown', url, source,
    fields: { fullText: 'A review. '.repeat(80) },
  }, { reviewTextsDir: dir });
  try {
    assert.doesNotMatch(String(w('newblogx', 'https://www.show-score.com/london-theater/dog-man', 'show-score').reason || ''), /unregistered-outlet-non-review-url/);
    assert.doesNotMatch(String(w('newblogy', 'https://newblogy.example/', 'gather-reviews').reason || ''), /unregistered-outlet-non-review-url/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('normalizeUrl treats independent.co.uk and the-independent.com as one article (BRO-5674)', () => {
  const path = '/arts-entertainment/theatre-dance/reviews/other-desert-cities-broadway-review-julia-louis-dreyfus-allison-janney-b3068662.html';
  const { normalizeUrl: n } = require('./review-normalization.js');
  assert.equal(n('https://www.independent.co.uk' + path), n('https://www.the-independent.com' + path));
  // host match is exact, not a suffix/prefix
  assert.notEqual(n('https://notindependent.co.uk' + path), n('https://www.the-independent.com' + path));
  assert.notEqual(n('https://independent.co.uk.example.com' + path), n('https://www.the-independent.com' + path));
});

test('normalizeUrl host aliases for other same-path domain moves (BRO-5674 cousins)', () => {
  const { normalizeUrl: n } = require('./review-normalization.js');
  const pairs = [
    ['https://www.thetimes.co.uk/article/x-review-abc123', 'https://www.thetimes.com/article/x-review-abc123'],
    ['https://www.dailymail.com/tvshowbiz/article-1/x.html', 'https://www.dailymail.co.uk/tvshowbiz/article-1/x.html'],
    ['https://www.huffingtonpost.com/entry/x_us_1', 'https://www.huffpost.com/entry/x_us_1'],
    ['https://amp.theguardian.com/stage/2026/x', 'https://www.theguardian.com/stage/2026/x'],
    ['https://www.guardian.co.uk/stage/2010/x', 'https://www.theguardian.com/stage/2010/x'],
    ['https://online.wsj.com/article/x.html', 'https://www.wsj.com/article/x.html'],
  ];
  for (const [a, b] of pairs) assert.equal(n(a), n(b), a);
  assert.notEqual(n('https://notthetimes.co.uk/article/x'), n('https://www.thetimes.com/article/x'));
});

test('legacy URL critic filenames resolve by stored byline and preserve flagged exclusions (BRO-2938)', () => {
  const { findExistingReviewFile } = require('./review-normalization.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2938-lookup-'));
  const file = 'broadwayworld--httpswwwbroadwayworldcomauthorrichard-sasanow.json';
  const data = {
    outletId: 'broadwayworld', criticName: 'Richard Sasanow',
    url: 'https://www.broadwayworld.com/article/review-carmen',
  };
  try {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
    // Pass 0 returns the stored identity on a URL match.
    assert.equal(findExistingReviewFile(dir, data.outletId, data.criticName, data.url)?.data.criticName, data.criticName);
    // The filename fast path skips the URL slug; Pass 2 recovers the byline.
    assert.equal(findExistingReviewFile(dir, data.outletId, data.criticName)?.filename, file);
    assert.equal(findExistingReviewFile(dir, data.outletId, 'Another Critic'), null);
    assert.equal(findExistingReviewFile(dir, data.outletId, 'Unknown'), null);
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ ...data, wrongProduction: true }));
    assert.equal(findExistingReviewFile(dir, data.outletId, data.criticName, data.url), null);
    assert.equal(findExistingReviewFile(dir, data.outletId, data.criticName), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('URL clusters read outlet prefixes and stored bylines independently of critic filenames (BRO-2938)', () => {
  const { findUrlClusters, outletOf } = require('./review-url-clusters.js');
  const review = {
    file: 'observer--httpsobservercomauthorrex-reed.json',
    outlet: 'Observer', criticName: 'Rex Reed', url: 'https://observer.com/review',
  };
  assert.equal(outletOf(review), 'observer');
  const [cluster] = findUrlClusters([review], 1);
  assert.deepEqual(cluster.bylines, ['Rex Reed']);
  assert.equal(cluster.outlet, 'observer');
});

test('normalizeUrl: AMP variants collapse to the plain URL, no trailing slash or glued params (BRO-5365)', () => {
  const { normalizeUrl: n } = require('./review-normalization.js');
  const plain = n('https://example.com/review');
  assert.equal(n('https://example.com/review/?amp=1'), plain);
  assert.equal(n('https://example.com/review?amp=1'), plain);
  assert.equal(n('https://example.com/review/amp/'), plain);
  assert.equal(n('https://example.com/review/?amp=1&page=2'), n('https://example.com/review?page=2'));
  assert.notEqual(n('https://example.com/review?page=2'), plain);
});

// BRO-6127: Theatre Record labels Mail on Sunday critics "Daily Mail".
test('resolveSplitOutletByCritic moves splitCritics bylines to the split child', () => {
  assert.equal(resolveSplitOutletByCritic('daily-mail', 'Robert Gore-Langton'), 'mail-on-sunday');
  assert.equal(resolveSplitOutletByCritic('daily-mail', 'Mark Cook'), 'mail-on-sunday');
  assert.equal(resolveSplitOutletByCritic('daily-mail', 'Quentin Crisp'), 'daily-mail');
  assert.equal(resolveSplitOutletByCritic('daily-mail', ''), 'daily-mail');
  assert.equal(resolveSplitOutletByCritic('guardian', 'Mark Cook'), 'guardian');
});

// BRO-6287 (side item 2): extraction follows the heal's label policy.
test('splitOutletForLabel: critic moves only a label with no edition signal', () => {
  const { splitOutletForLabel } = require('./outlet-mismatch-heal.js');
  assert.equal(splitOutletForLabel('daily-mail', 'Daily Mail', 'Robert Gore-Langton'), 'mail-on-sunday');
  assert.equal(splitOutletForLabel('daily-mail', 'DAILY MAIL', 'Robert Gore-Langton'), 'mail-on-sunday');
  assert.equal(splitOutletForLabel('daily-mail', 'Daily Mail', 'Quentin Crisp'), 'daily-mail');
  assert.equal(splitOutletForLabel('daily-mail', 'Daily Mail', ''), 'daily-mail');
});

test('BWW headline fragment starting with "Is" is junk, not a missing outlet (BRO-6645 Oct 29 The Heart)', () => {
  assert.equal(isJunkOutlet('Is Something Of A Miracle'), true);
  assert.equal(isJunkOutlet('Is A Triumph'), true);
  assert.equal(isJunkOutlet('Theater Pizzazz'), false);
  assert.equal(isJunkOutlet('Island Packet'), false);
});

// BRO-7769: a url swap onto a slot must not accept an article that never names the show.
const { mergeReviews } = require('./review-normalization.js');
const GT_TITLE = 'The Good Thief';
const goodThiefText = (n) => `${'The Good Thief opens at the theater and the cast delivers. '.repeat(n)}`;
const unrelatedText = 'Zach Grenier joins the cast of a new play this season, the company announced on Tuesday. '.repeat(12);
const slot = () => ({
  outlet: 'TheaterMania', outletId: 'theatermania', criticName: 'Linda Buchwald',
  url: 'https://www.theatermania.com/news/irish-rep-season-casting_1850000/', fullText: '',
});

test('BRO-7769: same-outlet url swap to an article that never mentions the show is refused', () => {
  const incoming = { ...slot(), url: 'https://www.theatermania.com/news/unknown-caller_1859996/', fullText: unrelatedText };
  const merged = mergeReviews(slot(), incoming, {}, { show: { title: GT_TITLE }, showId: 'the-good-thief-off-broadway-2026', script: 'test' });
  assert.equal(merged.url, slot().url);
  assert.ok(!merged.fullText || !merged.fullText.includes('Zach Grenier'));
});

test('BRO-7769: url swap to an article that names the show still goes through', () => {
  const incoming = { ...slot(), url: 'https://www.theatermania.com/off-broadway/reviews/the-good-thief_1861000/', fullText: goodThiefText(20) };
  const merged = mergeReviews(slot(), incoming, {}, { show: { title: GT_TITLE }, showId: 'the-good-thief-off-broadway-2026', script: 'test' });
  assert.equal(merged.url, incoming.url);
});

test('BRO-7769: guard fails open without a show title or with short incoming text', () => {
  const unrelated = { ...slot(), url: 'https://www.theatermania.com/news/unknown-caller_1859996/', fullText: unrelatedText };
  assert.equal(mergeReviews(slot(), unrelated, {}, { script: 'test' }).url, unrelated.url);
  const short = { ...unrelated, fullText: 'Paywalled teaser.' };
  assert.equal(mergeReviews(slot(), short, {}, { show: { title: GT_TITLE }, script: 'test' }).url, short.url);
});

test('BRO-7769: refused swap also refuses the unrelated article score, date and byline', () => {
  const ex = { ...slot(), criticName: 'Unknown' };
  const incoming = { ...ex, url: 'https://www.theatermania.com/news/unknown-caller_1859996/', fullText: unrelatedText, originalScore: 'B+', publishDate: '2026-01-05', criticName: 'Zed Q' };
  const m = mergeReviews(ex, incoming, {}, { show: { title: GT_TITLE }, script: 'test' });
  assert.equal(m.url, ex.url);
  assert.ok(!m.originalScore && !m.publishDate);
  assert.equal(m.criticName, 'Unknown');
});

test('BRO-7769: entity-encoded title and short titles do not trigger a false refusal', () => {
  const enc = 'Hell&#8217;s Kitchen opens tonight and the cast delivers. '.repeat(15);
  const a = { ...slot(), url: 'https://www.theatermania.com/news/some-headline_1_/', fullText: enc };
  assert.equal(mergeReviews(slot(), a, {}, { show: { title: "Hell's Kitchen" }, script: 'test' }).url, a.url);
  const b = { ...a, fullText: unrelatedText };
  assert.equal(mergeReviews(slot(), b, {}, { show: { title: 'SIX' }, script: 'test' }).url, b.url);
});

test('BRO-7769: refusal is idempotent and text just under the cutoff fails open', () => {
  const incoming = { ...slot(), url: 'https://www.theatermania.com/news/unknown-caller_1859996/', fullText: unrelatedText };
  const ctx = { show: { title: GT_TITLE }, script: 'test' };
  const once = mergeReviews(slot(), incoming, {}, ctx);
  const twice = mergeReviews(once, incoming, {}, ctx);
  assert.equal(twice.url, once.url);
  assert.equal(twice.fullText || '', once.fullText || '');
  const under = { ...incoming, fullText: 'Zach Grenier joins a cast. '.repeat(20).slice(0, 590) };
  assert.equal(mergeReviews(slot(), under, {}, ctx).url, under.url);
});

test('BRO-7769: guard fails open with an empty show title or no incoming fullText', () => {
  const noText = { ...slot(), url: 'https://www.theatermania.com/news/unknown-caller_1859996/' };
  delete noText.fullText;
  assert.equal(mergeReviews(slot(), noText, {}, { show: { title: GT_TITLE }, script: 'test' }).url, noText.url);
  const withText = { ...noText, fullText: unrelatedText };
  assert.equal(mergeReviews(slot(), withText, {}, { show: { title: '' }, script: 'test' }).url, withText.url);
  assert.equal(mergeReviews(slot(), withText, {}, { show: {}, script: 'test' }).url, withText.url);
});

test('BRO-7769: a substantive existing review keeps its url-swap behaviour (guard only protects weak slots)', () => {
  const ex = { ...slot(), fullText: 'A real review of the production. '.repeat(80) };
  const incoming = { ...ex, url: 'https://www.theatermania.com/news/other_1859996/', fullText: unrelatedText };
  assert.equal(mergeReviews(ex, incoming, {}, { show: { title: GT_TITLE }, script: 'test' }).url, incoming.url);
});
