import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bucketSoftTypeWrongShow } = require('../../scripts/lib/nonreview-soft-type-wrongshow');
const { isReviewTypeWrongShowGap } = require('../../scripts/lib/nonreview-contenttype-wrongshow');

// Original summaries of verified corpus cases, never copies of private text.
const show = { title: 'Fully Committed' };
const context = ' The announcement describes the cast, the creative team and the performance schedule for the production.';
const base = {
  isNonReview: true,
  nonReviewType: 'news',
  fullText: 'Signature Theater extended Incident at Vichy at the Pershing Square Signature Center.' + context,
};

describe('BRO-3875 report-only soft-type wrong-show coverage', () => {
  for (const nonReviewType of ['preview', 'interview', 'profile', 'feature', 'news', 'obituary']) {
    it(`surfaces ${nonReviewType} with no filed-title mention without promoting it`, () => {
      const data = { ...base, nonReviewType };
      const before = structuredClone(data);
      assert.equal(bucketSoftTypeWrongShow(data, show), 'wrong-show-suspect');
      assert.deepEqual(data, before);
      // The existing --apply/--gate predicate remains review-only.
      assert.equal(isReviewTypeWrongShowGap(data), false);
    });
  }

  it('keeps reviews, definitive junk types and unflagged files outside this population', () => {
    for (const nonReviewType of ['review', 'press_release', 'preview_article', undefined]) {
      assert.equal(bucketSoftTypeWrongShow({ ...base, nonReviewType }, show), null);
    }
    assert.equal(bucketSoftTypeWrongShow({ ...base, isNonReview: false }, show), null);
    assert.equal(bucketSoftTypeWrongShow(null, show), null);
  });

  it('retains a legitimate multi-show preview when its filed title is mentioned', () => {
    assert.equal(bucketSoftTypeWrongShow({ ...base, nonReviewType: 'preview',
      fullText: 'The season includes Fully Committed, Incident at Vichy and Preludes.' + context }, show), 'target-mentioned');
  });

  it('reuses the existing diacritic and punctuation tolerant title matcher', () => {
    assert.equal(bucketSoftTypeWrongShow({ ...base, fullText: 'A discussion of LES MISERABLES.' + context },
      { title: 'Les Misérables' }), 'target-mentioned');
    assert.equal(bucketSoftTypeWrongShow({ ...base, fullText: 'An interview about A Dolls House Part 2.' + context },
      { title: "A Doll's House, Part 2" }), 'target-mentioned');
  });

  it('uses canonical metadata rather than a URL or stale review showTitle', () => {
    assert.equal(bucketSoftTypeWrongShow({ ...base, showTitle: 'Incident at Vichy',
      url: 'https://example.com/fully-committed' }, show), 'wrong-show-suspect');
    assert.equal(bucketSoftTypeWrongShow(base, undefined), 'missing-show');
    assert.equal(bucketSoftTypeWrongShow(base, { title: ' ' }), 'missing-show');
  });

  it('does not mistake absent text for an absent show title', () => {
    for (const fullText of [null, undefined, '', '  ', 42]) {
      assert.equal(bucketSoftTypeWrongShow({ ...base, fullText }, show), 'missing-text');
    }
  });

  it('skips established wrong-show, wrong-production and content-verification exclusions', () => {
    for (const fields of [{ wrongShow: true }, { wrongProduction: true },
      { contentVerification: { wrongArticle: true, confidence: 'high' } },
      { rejectionReason: 'garbage_text' }]) {
      assert.equal(bucketSoftTypeWrongShow({ ...base, ...fields }, show), 'already-excluded');
    }
  });

  it('uses the canonical production-clear and verification-confidence rules', () => {
    assert.equal(bucketSoftTypeWrongShow({ ...base, wrongProduction: true,
      wrongProductionManualClear: true }, show), 'protected');
    assert.equal(bucketSoftTypeWrongShow({ ...base,
      contentVerification: { wrongArticle: true, confidence: 'low' } }, show), 'wrong-show-suspect');
  });

  it('honors human clears even when an old wrongShow flag remains', () => {
    assert.equal(bucketSoftTypeWrongShow({ ...base, wrongShow: true,
      wrongShowManualClear: true }, show), 'protected');
    assert.equal(bucketSoftTypeWrongShow({ ...base, nonReviewManualClear: true }, show), 'protected');
  });

  it('honors opening-night lane provenance', () => {
    assert.equal(bucketSoftTypeWrongShow({ ...base, showId: 'fully-committed-2016',
      productionVerified: 'aggregator', openingNightLane: {
        show: 'fully-committed-2016', night: '2016-04-25', source: 'aggregator',
        seenAt: '2016-04-26T01:00:00Z',
      } }, show), 'protected');
  });

  it('reports the verified John Proctor false positive as a suspect, never a verdict', () => {
    // The actual review omits its own title and describes students studying
    // The Crucible. A reverse title-frequency rule would flag the wrong play.
    const data = { ...base, nonReviewType: 'preview', fullText:
      'Kimberly Belflower writes about students studying The Crucible. The Crucible shapes their discussion.' };
    const before = structuredClone(data);
    assert.equal(bucketSoftTypeWrongShow(data, { title: 'John Proctor Is the Villain' }), 'wrong-show-suspect');
    assert.deepEqual(data, before);
    assert.equal(isReviewTypeWrongShowGap(data), false);
  });
});
