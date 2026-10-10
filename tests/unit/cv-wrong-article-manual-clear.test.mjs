// A high-confidence contentVerification.wrongArticle verdict is a hard exclusion
// with no human hatch until audit S3-T3 (BRO-4204): the CV pass reads truncated
// or context-heavy text and calls real in-window reviews "previews". The clear
// uses the protected breadcrumb family review-write-guard.js already honours for
// wrongAttribution/wrongFullText (wrongArticleManualClear / humanReviewedWrongArticle:false).
//
// Run: node --test tests/unit/cv-wrong-article-manual-clear.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { explainExclusion, isRejectedNonReview, cvWrongArticleManuallyCleared } = require(join(ROOT, 'scripts/lib/review-guards.js'));
const { PROTECTED_FIELDS } = require(join(ROOT, 'scripts/lib/review-write-guard.js'));

const show = { id: 'data-off-broadway-2026', title: 'Data', venue: 'Lucille Lortel Theatre', openingDate: '2026-01-09', category: 'off-broadway', market: 'broadway', status: 'closed' };
function file(extra = {}) {
  return {
    showId: show.id, outletId: 'nysr', outlet: 'New York Stage Review', criticName: 'Roma Torre',
    url: 'https://nystagereview.com/2026/01/25/data-scorching-play/', publishDate: '2026-01-25',
    fullText: 'If there is anything to be learned from Data, it is that we should be scared. '.repeat(40),
    contentTier: 'complete', assignedScore: 85, llmScore: { score: 85, confidence: 'high' },
    contentVerification: { isValid: true, wrongArticle: true, articleType: 'feature', confidence: 'high', verifiedAt: '2026-02-01T00:00:00Z' },
    ...extra,
  };
}

test('a high-confidence CV wrongArticle verdict excludes by default', () => {
  assert.equal(explainExclusion(file(), show), 'cvWrongArticleHighConfidence');
  assert.equal(isRejectedNonReview(file()), true);
  assert.equal(cvWrongArticleManuallyCleared(file()), false);
});

test('wrongArticleManualClear: true overrules it (explainExclusion and the scorer-side predicate)', () => {
  const d = file({ wrongArticleManualClear: true, wrongArticleManualClearReason: 'read it: this is the review' });
  assert.notEqual(explainExclusion(d, show), 'cvWrongArticleHighConfidence');
  assert.equal(explainExclusion(d, show), null);
  assert.equal(isRejectedNonReview(d), false);
});

test('humanReviewedWrongArticle: false overrules it; true or absent does not', () => {
  assert.equal(explainExclusion(file({ humanReviewedWrongArticle: false }), show), null);
  assert.equal(explainExclusion(file({ humanReviewedWrongArticle: true }), show), 'cvWrongArticleHighConfidence');
  assert.equal(explainExclusion(file({ wrongArticleManualClear: 'yes' }), show), 'cvWrongArticleHighConfidence', 'only the literal boolean clears');
});

test('a medium-confidence verdict never excluded and still does not', () => {
  const d = file({ contentVerification: { isValid: true, wrongArticle: true, articleType: 'feature', confidence: 'medium' } });
  assert.notEqual(explainExclusion(d, show), 'cvWrongArticleHighConfidence');
});

test('both breadcrumb fields are PROTECTED so a CI merge cannot drop the clear', () => {
  assert.ok(PROTECTED_FIELDS.includes('wrongArticleManualClear'));
  assert.ok(PROTECTED_FIELDS.includes('humanReviewedWrongArticle'));
});

test('wiring: both gates in review-guards.js call cvWrongArticleManuallyCleared', () => {
  const src = readFileSync(join(ROOT, 'scripts/lib/review-guards.js'), 'utf8');
  const gate1 = src.indexOf("!cvWrongArticleManuallyCleared(data)\n  ) return 'cvWrongArticleHighConfidence'");
  const gate2 = src.indexOf("cv.confidence === 'high' && !cvWrongArticleManuallyCleared(data)) return true");
  assert.ok(gate1 > 0, 'explainExclusion gate honours the hatch');
  assert.ok(gate2 > 0, 'isRejectedNonReview gate honours the hatch');
});
