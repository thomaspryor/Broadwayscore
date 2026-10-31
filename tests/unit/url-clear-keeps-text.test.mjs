// BRO-5374: a wrong "Full review" link on a review whose text is right is
// cleared to "" (no url-change invariant, so text and score stay). Allowed for
// aggregator urls, malformed urls, and provably wrong urls on Theatre Record
// print rows; never over a human url lock. Invented placeholder text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyReviewFieldEdit, executeReviewFieldEditIn } = require('../../scripts/lib/review-field-edit.js');
const { classifyReviewUrl } = require('../../scripts/lib/non-review-url-patterns.js');

const BODY = Array.from({ length: 20 }, (_, i) => `The revival moves briskly and the cast is in fine voice, note ${i}.`).join(' ');
const tr = (over = {}) => ({
  showId: 'a-show-west-end-2025', outletId: 'daily-mail', outlet: 'Daily Mail', criticName: 'A Critic',
  source: 'theatre-record', theatreRecordUrl: 'https://www.theatrerecord.com/archive/2025/7/1-a-show',
  url: 'https://www.dailymail.co.uk/tvshowbiz/index.html', fullText: BODY, contentTier: 'complete', assignedScore: 80, ...over,
});
const stamp = { fixId: 'bro-5374-t', at: '2026-10-14T00:00:00Z' };
const clear = (rec) => applyReviewFieldEdit(rec, { field: 'url', oldValue: rec.url, newValue: '' }, stamp, {});

test('section index and site-search urls are not review urls; real articles are', () => {
  assert.equal(classifyReviewUrl('https://www.dailymail.co.uk/mailonsunday/index.html').reason, 'section-index-page');
  assert.equal(classifyReviewUrl('https://www.express.co.uk/latest/theatre').reason, 'section-index-page');
  assert.equal(classifyReviewUrl('http://thebroadwayblog.com/?s=the+play').reason, 'site-search-page');
  assert.equal(classifyReviewUrl('https://www.dailymail.co.uk/tvshowbiz/article-1/A-review.html').ok, true);
  assert.equal(classifyReviewUrl('https://www.express.co.uk/entertainment/theatre/2087097/a-review').ok, true);
  assert.equal(classifyReviewUrl('https://www.susangranger.com/?p=10339').ok, true, 'a WordPress ?p= permalink is an article');
});

test('a Theatre Record row with an index url clears and keeps its text', () => {
  const r = clear(tr());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.record.url, '');
  assert.equal(r.record.fullText, BODY);
  assert.equal(r.record.needsRefetch, undefined);
});

test('a malformed url clears on any row; a real url on a web row is refused', () => {
  const web = { source: 'show-score', theatreRecordUrl: undefined };
  assert.equal(clear(tr({ ...web, url: 'http://Entertainment%20Weekly' })).ok, true);
  assert.equal(clear(tr({ ...web, url: 'http://thebroadwayblog.com/?s=x' })).ok, false, 'web row: its text may have come from that page');
  assert.equal(clear(tr({ url: 'https://www.dailymail.co.uk/tvshowbiz/article-1/A-review.html' })).ok, false, 'not provably wrong');
});

test('a human url lock is never cleared', () => {
  assert.equal(clear(tr({ urlVerified: true })).ok, false);
  assert.equal(clear(tr({ urlManualOverride: 'checked by hand' })).ok, false);
  assert.equal(clear(tr({ urlVerified: true, urlVerifiedAuto: true })).ok, true, 'an automatic verification is not a human lock');
});

test('through the write guard, the clear keeps text and score on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-clear-'));
  try {
    const rel = 'a-show-west-end-2025/daily-mail--a-critic.json';
    fs.mkdirSync(path.join(dir, 'a-show-west-end-2025'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(tr(), null, 2));
    const res = executeReviewFieldEditIn(dir, { file: rel, field: 'url', oldValue: tr().url, newValue: '' }, stamp);
    assert.equal(res.ok, true, res.reason);
    const after = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    assert.equal(after.url, '');
    assert.equal(after.fullText, BODY);
    assert.equal(after.assignedScore, 80);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// BRO-5373: a stale "not a review" verdict (isNotReview) can be cleared by plan,
// only after the manual-clear breadcrumb, and only to false.
test('isNotReview clears only to false and only after isNotReviewManualClear', () => {
  const rec = tr({ isNotReview: true, isNotReviewReason: 'stale roundup verdict' });
  assert.equal(applyReviewFieldEdit(rec, { field: 'isNotReview', oldValue: true, newValue: false }, stamp, {}).ok, false, 'breadcrumb first');
  const withClear = { ...rec, isNotReviewManualClear: true };
  assert.equal(applyReviewFieldEdit(withClear, { field: 'isNotReview', oldValue: true, newValue: true }, stamp, {}).ok, false);
  const r = applyReviewFieldEdit(withClear, { field: 'isNotReview', oldValue: true, newValue: false }, stamp, {});
  assert.equal(r.ok, true, r.reason);
  assert.equal(applyReviewFieldEdit(withClear, { field: 'isNotReviewReason', oldValue: 'stale roundup verdict', newValue: 'x' }, stamp, {}).ok, false);
});

// BRO-5243: audit-non-reviews.js's nonReviewFlag, stamped on an earlier
// fragment, can be cleared by plan the same way (true-west-2019 WSJ).
test('nonReviewFlag clears only to false and only after nonReviewManualClear', () => {
  const rec = tr({ nonReviewFlag: true });
  assert.equal(applyReviewFieldEdit(rec, { field: 'nonReviewFlag', oldValue: true, newValue: false }, stamp, {}).ok, false, 'breadcrumb first');
  const withClear = { ...rec, nonReviewManualClear: true };
  assert.equal(applyReviewFieldEdit(withClear, { field: 'nonReviewFlag', oldValue: true, newValue: true }, stamp, {}).ok, false);
  const r = applyReviewFieldEdit(withClear, { field: 'nonReviewFlag', oldValue: true, newValue: false }, stamp, {});
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.record.nonReviewFlag, false);
});

// BRO-5395: a real review whose body never prints the show's title can be
// cleared per file, after a breadcrumb that says what was checked.
test('showNotMentioned clears only to false and only after showNotMentionedManualClear', () => {
  const rec = tr({ showNotMentioned: true });
  assert.equal(applyReviewFieldEdit(rec, { field: 'showNotMentioned', oldValue: true, newValue: false }, stamp, {}).ok, false, 'breadcrumb first');
  assert.equal(applyReviewFieldEdit(rec, { field: 'showNotMentionedManualClear', oldValue: null, newValue: 'short' }, stamp, {}).ok, false, 'evidence required');
  const withClear = { ...rec, showNotMentionedManualClear: 'url, venue and dates match this production' };
  assert.equal(applyReviewFieldEdit(withClear, { field: 'showNotMentioned', oldValue: true, newValue: true }, stamp, {}).ok, false);
  const r = applyReviewFieldEdit(withClear, { field: 'showNotMentioned', oldValue: true, newValue: false }, stamp, {});
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.record.showNotMentioned, false);
});

// BRO-5420: a plan's isNonReview=true needs the manual marker, or a fresh CV
// demotes it and the row stays live (brighton-beach-memoirs-2009 LA Times).
test('isNonReview may be set true only after a "manual (not a review)" reason', () => {
  const set = { field: 'isNonReview', oldValue: null, newValue: true };
  assert.equal(applyReviewFieldEdit(tr({ isNonReviewReason: 'BRO-1: a feature' }), set, stamp, {}).ok, false);
  assert.equal(applyReviewFieldEdit(tr({ isNonReviewReason: 'manual (not a review): BRO-1: a feature' }), set, stamp, {}).ok, true);
  const { isNonReviewDemotedByFreshCV } = require('../../scripts/lib/review-guards.js');
  const freshCv = { articleType: 'review', isValid: true, confidence: 'high', verifiedAt: '2026-08-15T00:00:00Z' };
  assert.equal(isNonReviewDemotedByFreshCV({ isNonReview: true, isNonReviewReason: 'BRO-1: x', contentVerification: freshCv }), true, 'unmarked flag is demoted');
  assert.equal(isNonReviewDemotedByFreshCV({ isNonReview: true, isNonReviewReason: 'manual (not a review): BRO-1: x', contentVerification: freshCv }), false, 'marked flag holds');
});
