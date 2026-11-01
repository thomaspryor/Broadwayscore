// BRO-6745: a CV "not a review" label set on an old body must not outlive a refetch / body change.
// Requires the real predicates (CLAUDE.md 15) — nothing is re-implemented here.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { explainExclusion, isNonReviewDemotedByFreshCV, computeCvIsStale } = require('./review-guards.js');
const { contentHash } = require('./content-verifier.js');
const { selectCvPromotedNonReview } = require('./cv-promoted-nonreview-selector.js');

const truncated = 'Preview: the new revival opens next month at the Booth, with a starry cast. '.repeat(10);
const fullReview = 'The performances are superb and the staging is thrilling, though the second act sags. '.repeat(40);

function labelled(extra = {}) {
  return {
    outletId: 'theatermania', url: 'https://www.theatermania.com/x', showId: 's',
    fullText: fullReview, contentTier: 'complete', wordCount: 600,
    isNonReview: true, rejectionReason: 'not_a_review',
    isNonReviewReason: 'CV-promoted (not a review): plot summary / preview',
    contentVerification: {
      isValid: false, wrongArticle: true, wrongProduction: false, articleType: 'preview',
      confidence: 'high', verifiedAt: '2026-09-01T00:00:00Z', contentHash: contentHash(truncated),
    },
    ...extra,
  };
}
const ensemble = { llmScore: { score: 82, confidence: 'high' }, llmMetadata: { scoredAt: '2026-10-05T00:00:00Z' } };

test('label set on the old body, body refetched: stale, and the ensemble verdict demotes it', () => {
  const d = labelled({ ...ensemble, textFetchedAt: '2026-10-01T00:00:00Z' });
  assert.equal(computeCvIsStale(d), true);
  assert.equal(isNonReviewDemotedByFreshCV(d), true);
  assert.equal(explainExclusion(d), null);
});

test('hash no longer matches the stored body (no refetch stamp): same result', () => {
  const d = labelled(ensemble);
  assert.equal(computeCvIsStale(d), true);
  assert.equal(isNonReviewDemotedByFreshCV(d), true);
});

test('ensemble score older than the last refetch does not corroborate (it read a different body)', () => {
  const d = labelled({ ...ensemble, textFetchedAt: '2026-10-01T00:00:00Z', llmMetadata: { scoredAt: '2026-09-15T00:00:00Z' } });
  assert.equal(isNonReviewDemotedByFreshCV(d), false);
  assert.equal(explainExclusion(d), 'nonReview');
  const after = labelled({ ...ensemble, textFetchedAt: '2026-10-01T00:00:00Z', llmMetadata: { scoredAt: '2026-10-02T00:00:00Z' } });
  assert.equal(explainExclusion(after), null);
});

test('undated score, protected rows and different-show verdicts are never overruled', () => {
  const undated = labelled({ llmScore: { score: 82, confidence: 'high' } });
  assert.equal(isNonReviewDemotedByFreshCV(undated), false);
  assert.equal(isNonReviewDemotedByFreshCV(labelled({ ...ensemble, nonReviewOverride: 'human' })), false);
  assert.equal(isNonReviewDemotedByFreshCV(labelled({ ...ensemble, _locked: true })), false);
  const wrong = labelled(ensemble);
  wrong.contentVerification.wrongProduction = true;
  assert.equal(explainExclusion(wrong) === null, false);
});

test('stale label without an ensemble score stays excluded (needs a re-check, not a blind clear)', () => {
  const d = labelled({ textFetchedAt: '2026-10-01T00:00:00Z' });
  assert.equal(isNonReviewDemotedByFreshCV(d), false);
  assert.equal(explainExclusion(d), 'nonReview');
});

test('label on the SAME body is untouched, even with an ensemble score', () => {
  const d = labelled({ ...ensemble });
  d.contentVerification.contentHash = contentHash(fullReview);
  assert.equal(computeCvIsStale(d), false);
  assert.equal(isNonReviewDemotedByFreshCV(d), false);
  assert.equal(explainExclusion(d), 'nonReview');
});

test('a human-set flag is never demoted by staleness', () => {
  const d = labelled({ ...ensemble, manualNonReviewSet: true });
  assert.equal(isNonReviewDemotedByFreshCV(d), false);
  const classifier = labelled({ ...ensemble, isNonReviewReason: 'classifier: interview' });
  assert.equal(isNonReviewDemotedByFreshCV(classifier), false);
});

test('evaluative critic-outlet body: re-check selector picks it up whatever its hash state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6745-'));
  fs.mkdirSync(path.join(dir, 'show-a-2026'));
  fs.writeFileSync(path.join(dir, 'show-a-2026', 'theatermania--jane-doe.json'), JSON.stringify(labelled()));
  fs.writeFileSync(path.join(dir, 'show-a-2026', 'playbill--john-doe.json'), JSON.stringify(labelled({ nonReviewOverride: 'human' })));
  const picked = selectCvPromotedNonReview(dir, [{ id: 'show-a-2026', openingDate: '2026-03-01' }], { openedSince: '2025-11-01' });
  assert.deepEqual(picked.map((p) => p.file), ['theatermania--jane-doe.json']);
});
