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
const { contentHash } = require('../../scripts/lib/content-verifier.js');
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
    JSON.stringify({ ...base, contentVerification: { reverifiedFrom: 'stored-fullText', contentHash: contentHash(TEXT) } }));
  assert.equal(alreadyReverified({ fullText: TEXT, contentVerification: { reverifiedFrom: 'stored-fullText', contentHash: contentHash(TEXT) } }), true);
  const got = selectCvPromotedNonReview(dir, shows, { openedSince: '2026-07-01' }).map(f => f.file);
  assert.deepEqual(got, ['wrongshow.json']);
});

// BRO-6745: a "not a review" label set on an old fetch (a cookie banner) must be
// re-checked once the body is refetched; the old reverify stamp no longer counts.
const OLD_BODY = 'We use cookies to improve your experience. Accept all cookies. '.repeat(10);
const REVIEW_BODY = 'The revival is a triumph. The lead gives a ferocious, funny performance and the staging '
  + 'is the most inventive I have seen this season; the second act sags, but go. '.repeat(6);

test('BRO-6745: label set on an old body, body refetched -> file is re-selected for re-verify', () => {
  const stamped = {
    ...base,
    isNonReviewReason: 'CV-promoted (not a review): The scraped content is entirely cookie consent text',
    contentVerification: { reverifiedFrom: 'stored-fullText', contentHash: contentHash(OLD_BODY), wrongArticle: true, articleType: 'other' },
  };
  assert.equal(alreadyReverified({ ...stamped, fullText: OLD_BODY }), true, 'same body: skip');
  const refetched = { ...stamped, fullText: REVIEW_BODY };
  assert.equal(alreadyReverified(refetched), false, 'refetched body: verdict is stale');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6745-'));
  fs.mkdirSync(path.join(dir, 'new-show-2026'));
  fs.writeFileSync(path.join(dir, 'new-show-2026', 'outlet--critic.json'), JSON.stringify(refetched));
  const got = selectCvPromotedNonReview(dir, shows, { openedSince: '2026-07-01' }).map(f => f.file);
  assert.deepEqual(got, ['outlet--critic.json']);
});

test('BRO-6745: a reverify stamp with no contentHash does not count as done', () => {
  assert.equal(alreadyReverified({ fullText: REVIEW_BODY, contentVerification: { reverifiedFrom: 'stored-fullText' } }), false);
});

test('BRO-6745: evaluative review re-verified clean is cleared by planClear', () => {
  const d = { ...base, fullText: REVIEW_BODY };
  const verdict = { isValid: true, wrongArticle: false, articleType: 'review', articleTypeConfidence: 'high', confidence: 'high' };
  const plan = planClear(d, verdict, true);
  assert.equal(plan.clearNonReview, true);
  assert.equal(plan.heldBack, false);
});

// BRO-6745 review: verifyContent hashes the text after stripping a consent layer,
// so a consent-prefixed body re-verified once must not be re-selected every week.
const { stripConsentLayerPrefix } = require('../../scripts/lib/text-cleaning.js');
const CONSENT = 'Please note that your choices apply across all our subdomains. Once you give consent, a floating button will appear at the bottom of your screen, allowing you to change or withdraw your consent at any time. '
  + 'Number of Vendors seeking consent or relying on legitimate interest: 777 '.repeat(20)
  + 'With your acceptance, certain characteristics specific to your device might be requested and used to distinguish it from other devices (such as the installed fonts or plugins, the resolution of your screen) in support of the purposes explained in this notice. ';

test('BRO-6745: consent-prefixed body stamped with the verifier hash counts as done', () => {
  const body = CONSENT + REVIEW_BODY;
  assert.notEqual(stripConsentLayerPrefix(body), body, 'fixture must carry a strippable consent layer');
  const stamp = { reverifiedFrom: 'stored-fullText', contentHash: contentHash(stripConsentLayerPrefix(body)) };
  assert.equal(alreadyReverified({ fullText: body, contentVerification: stamp }), true);
});

test('BRO-6745: verifyContent skip-short verdict stays done only while the text is still short', async () => {
  const { verifyContent } = require('../../scripts/lib/content-verifier.js');
  const body = CONSENT + 'Short teaser.';
  const cv = await verifyContent({ scrapedText: body, showTitle: 'X', outletName: 'Y' });
  assert.equal(cv.verifiedBy, 'skip-short');
  const stamp = { ...cv, reverifiedFrom: 'stored-fullText' };
  assert.equal(alreadyReverified({ fullText: body, contentVerification: stamp }), true);
  assert.equal(alreadyReverified({ fullText: REVIEW_BODY, contentVerification: stamp }), false);
});

// BRO-6745: a clean, confident verdict on a row that kept its label was refused
// by a clear guard (title-mismatch false positive). It must be re-selected so a
// fixed guard gets another look, while a confirmed non-review verdict stays done.
test('BRO-6745: clean high verdict on a still-labelled row is re-selected; a not-a-review verdict stays done', () => {
  const stamp = { reverifiedFrom: 'stored-fullText', contentHash: contentHash(REVIEW_BODY), verifiedBy: 'llm:claude' };
  const held = { ...base, fullText: REVIEW_BODY, contentVerification: { ...stamp, isValid: true, wrongArticle: false, wrongProduction: false, confidence: 'high', articleTypeConfidence: 'high' } };
  assert.equal(alreadyReverified(held), false);
  const confirmed = { ...base, fullText: REVIEW_BODY, contentVerification: { ...stamp, isValid: false, wrongArticle: true, confidence: 'high', articleType: 'preview' } };
  assert.equal(alreadyReverified(confirmed), true);
  const lowArticle = { ...held, contentVerification: { ...held.contentVerification, articleTypeConfidence: 'medium' } };
  assert.equal(alreadyReverified(lowArticle), true, 'planClear would hold it back anyway; do not re-pay weekly');
});
