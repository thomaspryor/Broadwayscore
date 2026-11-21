// BRO-3497: selection + batching for re-extracting stale Talkin' Broadway
// reviews with the BRO-912 byline-anchored extractor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  classifyTbUrl, classifyReview, selectCandidates, buildBatches, isStaleTbReview, DEFAULT_FIX_DATE,
} = require('./lib/tb-reextract-selection.js');
const { dispatchCommand, parseArgs } = require('./re-extract-talkin-broadway-reviews.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const PRE = '2026-08-01T00:00:00Z';
const POST = '2026-10-01T00:00:00Z';
const review = (over = {}) => ({ contentTier: 'invalid', url: 'https://www.talkinbroadway.com/page/world/Gigi.html', textFetchedAt: PRE, ...over });

test('classifyTbUrl: review pages in every TB layout', () => {
  for (const u of [
    'https://www.talkinbroadway.com/page/world/Misbegotten2007.html',
    'https://www.talkinbroadway.com/page/ob/02_08_24b.html',
    'https://talkinbroadway.com/page/regional/chicago/ch912.html',
    'http://www.talkinbroadway.com/world/HandtoGod.html',
    'http://www.talkinbroadway.com/ob/10_21_09.html',
  ]) assert.equal(classifyTbUrl(u), 'review-page', u);
});

test('classifyTbUrl: forum, index, other paths, foreign and missing urls', () => {
  assert.equal(classifyTbUrl('https://www.talkinbroadway.com/allthatchat_new/d.php?id=2654662'), 'forum');
  assert.equal(classifyTbUrl('https://www.talkinbroadway.com/world/index.html'), 'index');
  assert.equal(classifyTbUrl('https://talkinbroadway.com/just-for-us-broadway-review/'), 'other-path');
  assert.equal(classifyTbUrl('https://www.nytimes.com/x.html'), 'non-tb');
  assert.equal(classifyTbUrl('https://eviltalkinbroadway.com/world/x.html'), 'non-tb');
  assert.equal(classifyTbUrl(''), 'missing');
  assert.equal(classifyTbUrl(null), 'missing');
  assert.equal(classifyTbUrl('not a url'), 'missing');
});

test('isStaleTbReview: low tiers only, manual fixes never', () => {
  for (const t of ['truncated', 'invalid', 'excerpt', 'stub']) assert.equal(isStaleTbReview({ contentTier: t }), true, t);
  assert.equal(isStaleTbReview({ contentTier: 'complete' }), false);
  assert.equal(isStaleTbReview({ contentTier: 'needs-rescrape' }), false);
  assert.equal(isStaleTbReview({ contentTier: 'stub', source: 'manual' }), false);
  assert.equal(isStaleTbReview(null), false);
});

test('classifyReview: drop reasons in rule order', () => {
  assert.deepEqual(classifyReview(review()), { eligible: true, reason: 'eligible' });
  assert.equal(classifyReview(review({ textFetchedAt: undefined })).eligible, true, 'unknown fetch date is treated as pre-fix');
  assert.equal(classifyReview(review({ contentTier: 'complete' })).reason, 'not-stale');
  assert.equal(classifyReview(review({ wrongProduction: true })).reason, 'flag:wrongProduction');
  assert.equal(classifyReview(review({ duplicateOf: 'x.json' })).reason, 'flag:duplicateOf');
  assert.equal(classifyReview(review({ incompleteReason: 'permanently_unavailable' })).reason, 'flag:permanently_unavailable');
  assert.equal(classifyReview(review({ url: 'https://www.talkinbroadway.com/world/index.html' })).reason, 'url:index');
  assert.equal(classifyReview(review({ textFetchedAt: POST })).reason, 'fetched-after-fix');
  assert.equal(classifyReview(review({ textFetchedAt: DEFAULT_FIX_DATE })).reason, 'fetched-after-fix', 'fix instant counts as post-fix');
  assert.equal(classifyReview(review({ textFetchedAt: POST }), { fixDate: '2026-11-01T00:00:00Z' }).eligible, true, 'fixDate is configurable');
});

test('selectCandidates: counts, ignores non-TB files, sorted output', () => {
  const entries = [
    { showId: 'b-show', file: 'talkinbroadway--matthew-murray.json', data: review() },
    { showId: 'a-show', file: 'talkinbroadway--unknown.json', data: review({ contentTier: 'stub' }) },
    { showId: 'a-show', file: 'talkinbroadway--x.json', data: review({ contentTier: 'complete' }) },
    { showId: 'a-show', file: 'talkinbroadway--y.json', data: review({ wrongShow: true }) },
    { showId: 'a-show', file: 'nytimes--someone.json', data: review() },
  ];
  const { summary, candidates } = selectCandidates(entries);
  assert.equal(summary.tbFiles, 4);
  assert.equal(summary.stale, 3);
  assert.equal(summary.eligible, 2);
  assert.deepEqual(summary.byReason, { eligible: 2, 'flag:wrongShow': 1 });
  assert.deepEqual(summary.byTier, { invalid: 2, stub: 1 });
  assert.deepEqual(candidates.map((c) => c.showId), ['a-show', 'b-show']);
});

test('buildBatches: force-prefixed review keys, deduped show filter, sized max_reviews', () => {
  const cands = [
    { showId: 's1', file: 'talkinbroadway--a.json' },
    { showId: 's1', file: 'talkinbroadway--b.json' },
    { showId: 's2', file: 'talkinbroadway--c.json' },
  ];
  const b = buildBatches(cands, 2);
  assert.equal(b.length, 2);
  assert.equal(b[0].review_filter, 'force:s1/talkinbroadway--a.json,force:s1/talkinbroadway--b.json');
  assert.equal(b[0].show_filter, 's1');
  assert.equal(b[0].max_reviews, '2');
  assert.equal(b[1].review_filter, 'force:s2/talkinbroadway--c.json');
  assert.deepEqual(buildBatches([], 25), []);
  assert.equal(buildBatches(cands, 0).length, 1, 'bad size falls back to 25');
});

test('batch review_filter parses into keys the collector targets and force-refetches', () => {
  const { parseReviewFilter, matchesReviewFilter, isForcedRefetch } = require('./lib/review-filter.js');
  const [b] = buildBatches([{ showId: 's1', file: 'talkinbroadway--a.json' }], 25);
  const f = parseReviewFilter(b.review_filter);
  assert.equal(matchesReviewFilter(f, 's1', 'talkinbroadway--a.json'), true);
  assert.equal(matchesReviewFilter(f, 's2', 'talkinbroadway--a.json'), false, 'key is show-scoped, not a bare filename');
  assert.equal(isForcedRefetch(f, 's1', 'talkinbroadway--a.json'), true);
});

test('dispatchCommand never chains and quotes inputs', () => {
  const cmd = dispatchCommand({ max_reviews: '1', show_filter: "o'show", review_filter: 'force:x/y.json' });
  assert.match(cmd, /-f chain=false/);
  assert.match(cmd, /show_filter='o'\\''show'/);
  assert.throws(() => parseArgs(['--fix-date=nope']), /not a date/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('CLI: counts a fixture dir and prints a limited trial batch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reextract-'));
  try {
    const put = (show, file, data) => {
      fs.mkdirSync(path.join(dir, show), { recursive: true });
      fs.writeFileSync(path.join(dir, show, file), JSON.stringify(data));
    };
    put('show-a', 'talkinbroadway--one.json', review());
    put('show-b', 'talkinbroadway--two.json', review({ contentTier: 'excerpt' }));
    put('show-b', 'talkinbroadway--three.json', review({ url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=1' }));
    const out = JSON.parse(execFileSync(process.execPath,
      [path.join(here, 're-extract-talkin-broadway-reviews.js'), `--dir=${dir}`, '--batches', '--limit=1', '--json'],
      { encoding: 'utf8' }));
    assert.equal(out.summary.stale, 3);
    assert.equal(out.summary.eligible, 2);
    assert.equal(out.summary.byReason['url:forum'], 1);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.batches.length, 1);
    assert.equal(out.batches[0].review_filter, 'force:show-a/talkinbroadway--one.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
