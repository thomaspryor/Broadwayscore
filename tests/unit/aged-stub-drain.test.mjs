// BRO-6123: closed-show stubs with a URL and zero fetch attempts were starved
// behind the open-show backlog (176 theatre.reviews files, 2026-10-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  AGED_STUB_DRAIN_PER_RUN, isAgedNeverAttemptedStub, promoteAgedStubs, compareReviewPriority,
} = require('../../scripts/lib/collection-priority.js');
const { findAgedStubs, assessShow } = require('../../scripts/lib/uncollected-strand.js');

const NOW = Date.parse('2026-10-24T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
// The real findReviewsToProcess reads Date.now(); fixtures for it must be relative to the live clock (BRO-6328).
const liveHoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

test('isAgedNeverAttemptedStub: URL, zero attempts, older than 48h', () => {
  const base = { url: 'https://x.test/r', incompleteReason: 'not_attempted', fetchAttempts: [], firstSeenAt: hoursAgo(60) };
  assert.equal(isAgedNeverAttemptedStub(base, { nowMs: NOW }), true);
  assert.equal(isAgedNeverAttemptedStub({ ...base, firstSeenAt: hoursAgo(10) }, { nowMs: NOW }), false, 'too young');
  assert.equal(isAgedNeverAttemptedStub({ ...base, fetchAttempts: [{ at: 'x' }] }, { nowMs: NOW }), false, 'already attempted');
  assert.equal(isAgedNeverAttemptedStub({ ...base, url: '' }, { nowMs: NOW }), false, 'no url');
  assert.equal(isAgedNeverAttemptedStub({ ...base, _locked: true }, { nowMs: NOW }), false, 'locked');
  assert.equal(isAgedNeverAttemptedStub({ ...base, firstSeenAt: undefined }, { nowMs: NOW }), true, 'unknown age counts as aged');
  assert.equal(isAgedNeverAttemptedStub({ url: 'https://x.test/r', fetchAttempts: null }, { nowMs: NOW }), false, 'complete/legacy file with null attempts is not a stub');
  assert.equal(isAgedNeverAttemptedStub({ ...base, incompleteReason: 'paywall' }, { nowMs: NOW }), false, 'failed/other reason is not a stub');
  assert.equal(isAgedNeverAttemptedStub({ ...base, fullText: 'body' }, { nowMs: NOW }), false, 'has text');
  assert.equal(isAgedNeverAttemptedStub(null), false);
});

test('aged closed-show stub is pulled inside the max_reviews cut, bounded by the cap', () => {
  const fresh = Array.from({ length: 400 }, (_, i) => ({
    reviewId: `open/${i}`, isOpenShow: true, recencyDate: '2026-10-01', fetchAttempts: 0, priority: 2,
  }));
  const stubs = Array.from({ length: 60 }, (_, i) => ({
    reviewId: `closed-2024/${i}`, isOpenShow: false, recencyDate: '2024-05-01', fetchAttempts: 0, priority: 2,
    _agedStub: true,
  }));
  const queue = [...fresh, ...stubs].sort((a, b) => compareReviewPriority(a, b));
  assert.ok(queue.indexOf(stubs[0]) >= 300, 'precondition: starved past max_reviews=300');
  const out = promoteAgedStubs(queue, AGED_STUB_DRAIN_PER_RUN, 1);
  assert.equal(out.length, queue.length);
  const head = out.slice(0, AGED_STUB_DRAIN_PER_RUN);
  assert.ok(head.every(r => r._agedStub), 'cap-sized head is all aged stubs');
  assert.equal(out.slice(AGED_STUB_DRAIN_PER_RUN).filter(r => r._agedStub).length, 60 - AGED_STUB_DRAIN_PER_RUN, 'spend bounded: the rest wait');
  const other = promoteAgedStubs(queue, AGED_STUB_DRAIN_PER_RUN, 2).slice(0, AGED_STUB_DRAIN_PER_RUN).map(r => r.reviewId);
  assert.notDeepEqual(other, head.map(r => r.reviewId), 'a different run draws different stubs (no fixed subset starves the rest)');
  assert.deepEqual(promoteAgedStubs(queue, AGED_STUB_DRAIN_PER_RUN, 1).slice(0, AGED_STUB_DRAIN_PER_RUN).map(r => r.reviewId), head.map(r => r.reviewId), 'same run is deterministic');
});

test('findReviewsToProcess (real function) queues an aged closed-show stub inside the cut', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6123-'));
  const prevCwd = process.cwd();
  const prevEnv = { MAX_REVIEWS: process.env.MAX_REVIEWS, REVIEW_FILTER: process.env.REVIEW_FILTER };
  try {
    fs.mkdirSync(path.join(tmp, 'data/review-texts/open-show'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'data/review-texts/closed-show'), { recursive: true });
    const write = (show, file, extra) => fs.writeFileSync(path.join(tmp, 'data/review-texts', show, file), JSON.stringify({
      showId: show, outletId: file.split('--')[0], outlet: file.split('--')[0], criticName: 'A Critic',
      url: `https://example.test/${show}/${file}`, source: 'theatre-reviews', contentTier: 'stub',
      incompleteReason: 'not_attempted', fetchAttempts: [], ...extra,
    }));
    for (let i = 0; i < 20; i++) write('open-show', `outlet${i}--critic.json`, { firstSeenAt: liveHoursAgo(1) });
    write('closed-show', 'guardian--chris-wiegand.json', { firstSeenAt: liveHoursAgo(72) });
    write('closed-show', 'standard--young.json', { firstSeenAt: liveHoursAgo(2) });
    fs.writeFileSync(path.join(tmp, 'data/shows.json'), JSON.stringify({ shows: [
      { id: 'open-show', status: 'open', openingDate: '2026-09-01' },
      { id: 'closed-show', status: 'closed', openingDate: '2024-05-01' },
    ] }));
    process.chdir(tmp);
    process.env.MAX_REVIEWS = '5';
    delete process.env.REVIEW_FILTER;
    delete require.cache[require.resolve('../../scripts/collect-review-texts.js')];
    const { findReviewsToProcess } = require('../../scripts/collect-review-texts.js');
    const queue = findReviewsToProcess();
    const ids = queue.map(r => r.reviewId);
    assert.equal(queue.length, 5);
    assert.equal(ids[0], 'closed-show/guardian--chris-wiegand.json', 'aged stub leads the queue');
    assert.ok(!ids.includes('closed-show/standard--young.json'), 'a young stub keeps its normal (starved) position');
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('audit: findAgedStubs flags closed-show stubs the live-only strand check ignores', () => {
  const stub = (extra) => ({ url: 'https://x.test/r', outlet: 'Guardian', incompleteReason: 'not_attempted', fetchAttempts: [], ...extra });
  const files = [
    { file: 'old.json', review: stub({ firstSeenAt: hoursAgo(72) }) },
    { file: 'young.json', review: stub({ firstSeenAt: hoursAgo(5) }) },
    { file: 'undated.json', review: stub({}) },
    { file: 'tried.json', review: stub({ firstSeenAt: hoursAgo(72), fetchAttempts: [{ at: 'x' }] }) },
    { file: 'dup.json', review: stub({ firstSeenAt: hoursAgo(72), duplicateOf: 'old.json' }) },
    { file: 'text.json', review: stub({ firstSeenAt: hoursAgo(72), fullText: 'body' }) },
  ];
  const aged = findAgedStubs(files, { nowMs: NOW }).map(a => a.file).sort();
  assert.deepEqual(aged, ['old.json', 'undated.json']);
  const closed = { id: 'closed-show', status: 'closed' };
  assert.equal(assessShow(closed, files, { nowMs: NOW }), null, 'precondition: live-only check is blind to closed shows');
});
