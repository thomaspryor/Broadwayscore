/**
 * BRO-3126: a preview-period "first look" (jane-eyre-off-west-end-2026, LBO, scored 79,
 * shipped to prod) must not count as a critic review. Per CLAUDE.md rule 15 these
 * require() the real functions.
 *
 * The rule is deliberately narrow (see isPreviewFirstLookPiece): the verifier's
 * articleType=preview verdict alone mislabels genuine reviews (34 counted files on
 * 2026-10-10: NYT, Variety, EW, TheaterMania), and body text alone also appears in genuine
 * reviews. It takes BOTH, and a human clear wins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guards = require('../../scripts/lib/review-guards.js');
const { decideInclusion } = require('../../scripts/scoring-delta.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { isPreviewFirstLookPiece, explainExclusion } = guards;

// The disclaimer wording is quoted from the Jane Eyre file (BRO-3126 evidence), with the middle elided.
const JANE_EYRE = {
  outletId: 'london-box-office', criticName: 'Shehrazade Zafar-Arif', assignedScore: 79, contentTier: 'complete',
  url: 'https://www.londonboxoffice.co.uk/news/post/review-jane-eyre-southwark-playhouse-elephant',
  fullText: 'Please note: Jane Eyre is still in previews at Southwark Playhouse Elephant and does not officially open until Tuesday 8 September 2026. This piece is a first look at the production during its preview period ... rather than a review of the finished production. ' + 'x'.repeat(2000),
  contentVerification: { isValid: false, articleType: 'preview', articleTypeConfidence: 'high', issues: ['Content is a preview, not a review'] },
};
const SHOW = { id: 'jane-eyre-off-west-end-2026', category: 'off-west-end', openingDate: '2026-09-08', status: 'open' };

test('the Jane Eyre first-look piece is recognised and excluded', () => {
  assert.equal(isPreviewFirstLookPiece(JANE_EYRE), true);
  assert.equal(explainExclusion(JANE_EYRE, SHOW), 'previewFirstLookPiece');
});

test('a genuine review the verifier mislabelled as preview keeps counting (the reason the rule is narrow)', () => {
  const mislabelled = {
    ...JANE_EYRE, outletId: 'nytimes', criticName: 'Laura Collins-Hughes',
    fullText: 'Keanu Reeves and Alex Winter are superb in this Waiting for Godot. The production, still in previews when the cast was announced, now plays with real assurance. ' + 'y'.repeat(2500),
    contentVerification: { isValid: false, articleType: 'preview', articleTypeConfidence: 'high', issues: ['Article is a PREVIEW, not a REVIEW'] },
  };
  assert.equal(isPreviewFirstLookPiece(mislabelled), false, 'verdict alone is not enough');
  assert.notEqual(explainExclusion(mislabelled, SHOW), 'previewFirstLookPiece');
});

test('a critic mentioning a first look inside a real review is not caught', () => {
  const real = { ...JANE_EYRE, fullText: 'Having had a first look at the production when it was still in previews, I returned after opening night and it has only improved. ' + 'z'.repeat(2500) };
  assert.equal(isPreviewFirstLookPiece(real), false);
});

test('each requirement is load-bearing', () => {
  const noDisclaimer = { ...JANE_EYRE, fullText: 'A fine first outing for the company. ' + 'z'.repeat(2500) };
  assert.equal(isPreviewFirstLookPiece(noDisclaimer), false, 'verdict without the self-description');
  const onlyFirstLook = { ...JANE_EYRE, fullText: 'This piece is a first look at the production. ' + 'z'.repeat(2500) };
  assert.equal(isPreviewFirstLookPiece(onlyFirstLook), false, 'needs the still-in-previews statement too');
  const reviewVerdict = { ...JANE_EYRE, contentVerification: { ...JANE_EYRE.contentVerification, articleType: 'review' } };
  assert.equal(isPreviewFirstLookPiece(reviewVerdict), false, 'disclaimer without the preview verdict');
  assert.equal(isPreviewFirstLookPiece({ ...JANE_EYRE, contentVerification: { ...JANE_EYRE.contentVerification, isValid: true } }), false);
  assert.equal(isPreviewFirstLookPiece({ ...JANE_EYRE, contentVerification: { ...JANE_EYRE.contentVerification, articleTypeConfidence: 'medium' } }), false, 'high confidence only');
  assert.equal(isPreviewFirstLookPiece({ ...JANE_EYRE, contentVerification: undefined }), false);
  assert.equal(isPreviewFirstLookPiece(null), false);
});

test('a human clear on the content verification wins', () => {
  assert.equal(isPreviewFirstLookPiece({ ...JANE_EYRE, nonReviewManualClear: true }), false);
  assert.equal(isPreviewFirstLookPiece({ ...JANE_EYRE, wrongArticleManualClear: true }), false);
});

test('rebuild-all-reviews.js enforces the rule in its main loop, ahead of the flag-writing branches', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /if \(isPreviewFirstLookPiece\(data\)\) \{\s*logExclusion\("skippedPreviewFirstLookPiece"/);
  const nonReview = src.indexOf('logExclusion("skippedNonReview"');
  assert.ok(nonReview > 0);
  assert.ok(src.indexOf('isPreviewFirstLookPiece(data)') < nonReview);
});

test('scoring-delta decideInclusion replays the rule, and flips when the predicate is absent', () => {
  assert.deepEqual(decideInclusion(JANE_EYRE, SHOW, guards), { included: false, reason: 'previewFirstLookPiece' });
  const before = { ...guards, isPreviewFirstLookPiece: undefined };
  assert.equal(decideInclusion(JANE_EYRE, SHOW, before).included, true);
});
