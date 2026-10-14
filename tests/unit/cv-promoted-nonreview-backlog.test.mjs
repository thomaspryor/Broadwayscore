import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectCvPromotedNonReview, isCvPromotedNonReviewCandidate } =
  require('../../scripts/lib/cv-promoted-nonreview-selector.js');

const TEXT = 'x'.repeat(400);
const base = { isNonReview: true, isNonReviewReason: 'CV-promoted (not a review): opening night', fullText: TEXT };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4552-'));
  const put = (show, file, d) => {
    fs.mkdirSync(path.join(dir, show), { recursive: true });
    fs.writeFileSync(path.join(dir, show, file), JSON.stringify(d));
  };
  put('new-show-2026', 'a--b.json', base);
  put('new-show-2026', 'short.json', { ...base, fullText: 'tiny' });
  put('new-show-2026', 'classifier.json', { ...base, isNonReviewReason: 'gemini: roundup' });
  put('new-show-2026', 'not-flagged.json', { ...base, isNonReview: false });
  put('new-show-2026', 'locked.json', { ...base, _locked: true });
  put('new-show-2026', 'manual.json', { ...base, manualContentTier: 'complete' });
  put('new-show-2026', 'overridden.json', { ...base, nonReviewOverride: 'human' });
  put('new-show-2026', 'wrongshow.json', { ...base, wrongShow: true });
  put('old-show-2020', 'a--b.json', base);
  return dir;
}
const shows = [
  { id: 'new-show-2026', openingDate: '2026-08-10' },
  { id: 'old-show-2020', openingDate: '2020-03-01' },
  { id: 'missing-dir-2026', openingDate: '2026-09-01' },
];

test('selects CV-promoted population, skips human-protected and non-matching files', () => {
  const dir = fixture();
  const got = selectCvPromotedNonReview(dir, shows, { openedSince: '2026-07-01' })
    .map(f => `${f.showId}/${f.file}`);
  assert.deepEqual(got, ['new-show-2026/a--b.json', 'new-show-2026/wrongshow.json']);
});

test('without --opened-since, older shows are included', () => {
  const dir = fixture();
  const got = selectCvPromotedNonReview(dir, shows).map(f => f.showId);
  assert.ok(got.includes('old-show-2020'));
});

test('predicate rejects non-CV reasons and short text', () => {
  assert.equal(isCvPromotedNonReviewCandidate({ ...base, fullText: 'a' }), false);
  assert.equal(isCvPromotedNonReviewCandidate({ ...base, isNonReviewReason: 'Collector LLM' }), false);
  assert.equal(isCvPromotedNonReviewCandidate(base), true);
});

test('reverify script wires the selector flag', () => {
  const src = fs.readFileSync(new URL('../../scripts/reverify-stale-cv-promoted.js', import.meta.url), 'utf8');
  assert.match(src, /--cv-promoted-nonreview/);
  assert.match(src, /selectCvPromotedNonReview\(/);
});

const { planClear, alreadyReverified } = require('../../scripts/lib/cv-promoted-nonreview-selector.js');
const high = { confidence: 'high', articleTypeConfidence: 'high' };

test('planClear: clean high verdict clears isNonReview and wrongShow together', () => {
  const p = planClear({ ...base, wrongShow: true }, high, true);
  assert.deepEqual([p.clearWrong, p.wrongShowOnly, p.clearNonReview], [true, true, true]);
});

test('planClear: wrongProduction file gets the full clear', () => {
  const p = planClear({ ...base, wrongProduction: true }, high, true);
  assert.deepEqual([p.clearWrong, p.wrongShowOnly, p.clearNonReview], [true, false, true]);
});

test('planClear: medium article confidence clears NOTHING (no stranding partial clear)', () => {
  const p = planClear({ ...base, wrongShow: true }, { confidence: 'high', articleTypeConfidence: 'medium' }, true);
  assert.deepEqual([p.clearWrong, p.clearNonReview, p.heldBack], [false, false, true]);
});

test('planClear: not clean clears nothing; isNonReview-only works', () => {
  assert.equal(planClear(base, high, false).clearNonReview, false);
  assert.equal(planClear(base, high, true).clearNonReview, true);
  assert.equal(planClear({ wrongShow: true }, { confidence: 'high' }, true).clearWrong, true);
});

test('selector skips files already re-verified from stored text', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'new-show-2026', 'a--b.json'),
    JSON.stringify({ ...base, contentVerification: { reverifiedFrom: 'stored-fullText' } }));
  assert.equal(alreadyReverified({ contentVerification: { reverifiedFrom: 'stored-fullText' } }), true);
  const got = selectCvPromotedNonReview(dir, shows, { openedSince: '2026-07-01' }).map(f => f.file);
  assert.ok(!got.includes('a--b.json') || !got.some(f => f === 'a--b.json' && false));
  assert.deepEqual(got, ['wrongshow.json']);
});
