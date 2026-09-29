/**
 * Unit tests for scripts/lib/consent-refetch.js — the consent-backlog auto-drain
 * decision. Lets a wrongShow/wrongProduction review whose STORED text is garbage
 * (empty/consent-wall) re-fetch once the consent-dismissing scraper landed,
 * cooldown-gated. Must NEVER match a flag on a review with real buried text.
 *
 * Run: node --test tests/unit/consent-refetch.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldRetryGarbageConsentWall, REFETCH_COOLDOWN_MS } = require('../../scripts/lib/consent-refetch');

const NOW = 1_750_000_000_000;

describe('shouldRetryGarbageConsentWall', () => {
  it('retries when stored text is garbage and never retried before', () => {
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: true, lastRetryMs: null, nowMs: NOW }),
      true
    );
  });

  it('does NOT retry when stored text is NOT garbage (real buried review)', () => {
    // helen-shaw case: newsletter prefix + real review → isGarbage=false → leave it.
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: false, lastRetryMs: null, nowMs: NOW }),
      false
    );
  });

  it('respects the cooldown: no retry within 14 days of the last attempt', () => {
    const oneDayAgo = NOW - 24 * 60 * 60 * 1000;
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: true, lastRetryMs: oneDayAgo, nowMs: NOW }),
      false
    );
  });

  it('retries again after the cooldown elapses', () => {
    const longAgo = NOW - (REFETCH_COOLDOWN_MS + 1000);
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: true, lastRetryMs: longAgo, nowMs: NOW }),
      true
    );
  });

  it('returns false on bad/missing nowMs (defensive)', () => {
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: true, lastRetryMs: null, nowMs: undefined }),
      false
    );
  });

  it('returns false on empty ctx', () => {
    assert.strictEqual(shouldRetryGarbageConsentWall(), false);
    assert.strictEqual(shouldRetryGarbageConsentWall({}), false);
  });
});

// BRO-4185 A: WhatsOnStage captures open with an IAB consent layer (~6,500
// chars) ahead of the real article. Synthetic fixture built from the
// consent layer's actual opening and closing sentences.
const { storedTextNeedsConsentRefetch, shouldReleaseConsentLayerNonReview } = require('../../scripts/lib/consent-refetch');
const { stripConsentLayerPrefix, hasStrippableConsentLayer, cleanText } = require('../../scripts/lib/text-cleaning');

const CONSENT_LAYER = 'Please note that your choices apply across all our subdomains. Once you give consent, a floating button will appear at the bottom of your screen, allowing you to change or withdraw your consent at any time. '
  + 'Number of Vendors seeking consent or relying on legitimate interest: 777 '.repeat(20)
  + 'With your acceptance, certain characteristics specific to your device might be requested and used to distinguish it from other devices (such as the installed fonts or plugins, the resolution of your screen) in support of the purposes explained in this notice. ';
const ARTICLE = 'Faith is pulled in many different ways in this new show. Jeezus! follows an adolescent Peruvian Catholic caught between devotion and desire. '
  + 'The performances crackle, the direction never flags, and the score lands every joke while finding real sincerity underneath. '.repeat(8);

describe('stripConsentLayerPrefix', () => {
  it('removes a leading consent layer and keeps the article', () => {
    const out = stripConsentLayerPrefix(CONSENT_LAYER + ARTICLE);
    assert.ok(out.startsWith('Faith is pulled'), out.slice(0, 80));
    assert.strictEqual(hasStrippableConsentLayer(CONSENT_LAYER + ARTICLE), true);
  });

  it('cleanText strips it too', () => {
    assert.ok(cleanText(CONSENT_LAYER + ARTICLE).startsWith('Faith is pulled'));
  });

  it('leaves text untouched when the consent marker is not at the front', () => {
    const t = ARTICLE + ' ' + CONSENT_LAYER;
    assert.strictEqual(stripConsentLayerPrefix(t), t);
    assert.strictEqual(hasStrippableConsentLayer(t), false);
  });

  it('leaves text untouched when the closing sentence is missing', () => {
    const t = 'Please note that your choices apply across all our subdomains. ' + ARTICLE;
    assert.strictEqual(stripConsentLayerPrefix(t), t);
  });

  it('leaves a plain review untouched', () => {
    assert.strictEqual(stripConsentLayerPrefix(ARTICLE), ARTICLE);
  });
});

describe('storedTextNeedsConsentRefetch', () => {
  it('true for a consent-prefixed fullText', () => {
    assert.strictEqual(storedTextNeedsConsentRefetch({ fullText: CONSENT_LAYER + ARTICLE }), true);
  });
  it('true for a consent-prefixed quarantined wrongFullText when fullText is null', () => {
    assert.strictEqual(storedTextNeedsConsentRefetch({ fullText: null, wrongFullText: CONSENT_LAYER + ARTICLE }), true);
  });
  it('false for a real review', () => {
    assert.strictEqual(storedTextNeedsConsentRefetch({ fullText: ARTICLE }), false);
  });
  it('false when quarantined text is a real (other-show) review', () => {
    assert.strictEqual(storedTextNeedsConsentRefetch({ fullText: null, wrongFullText: ARTICLE }), false);
  });
});

describe('shouldReleaseConsentLayerNonReview', () => {
  const cleanCv = { isValid: true, wrongArticle: false, wrongProduction: false, isFilmTv: false, articleType: 'review', articleTypeConfidence: 'high' };
  const base = { isNonReview: true, isNonReviewReason: 'CV-promoted (not a review): The scraped content is cookie consent', contentVerification: cleanCv, fullText: ARTICLE };

  it('releases a CV-promoted flag after a clean high-confidence re-verify', () => {
    assert.strictEqual(shouldReleaseConsentLayerNonReview(base), true);
  });
  it('releases a Collector LLM flag too', () => {
    assert.strictEqual(shouldReleaseConsentLayerNonReview({ ...base, isNonReviewReason: 'Collector LLM: not a review (other)' }), true);
  });
  it('keeps a classifier-set flag', () => {
    assert.strictEqual(shouldReleaseConsentLayerNonReview({ ...base, isNonReviewReason: 'gemini: interview' }), false);
  });
  it('keeps the flag when the fresh verdict is not a high-confidence review', () => {
    assert.strictEqual(shouldReleaseConsentLayerNonReview({ ...base, contentVerification: { ...cleanCv, articleType: 'news' } }), false);
    assert.strictEqual(shouldReleaseConsentLayerNonReview({ ...base, contentVerification: { ...cleanCv, articleTypeConfidence: 'medium' } }), false);
    assert.strictEqual(shouldReleaseConsentLayerNonReview({ ...base, contentVerification: { ...cleanCv, wrongArticle: true } }), false);
  });
  it('keeps the flag when stored text still opens with the consent layer', () => {
    assert.strictEqual(shouldReleaseConsentLayerNonReview({ ...base, fullText: CONSENT_LAYER + ARTICLE }), false);
  });
});

describe('salvageConsentPrefixedStoredText', () => {
  const LONG = ARTICLE + ' ' + ARTICLE;
  const { salvageConsentPrefixedStoredText } = require('../../scripts/lib/consent-refetch');
  it('returns the stripped article from a consent-prefixed fullText', () => {
    assert.ok(salvageConsentPrefixedStoredText({ fullText: CONSENT_LAYER + LONG }).startsWith('Faith is pulled'));
  });
  it('returns the stripped quarantined text when fullText is empty', () => {
    assert.ok(salvageConsentPrefixedStoredText({ fullText: null, wrongFullText: CONSENT_LAYER + LONG }).startsWith('Faith is pulled'));
  });
  it('prefers a clean refilled fullText over the quarantined capture', () => {
    const clean = 'Yousef Sweid is absolutely clear of the difficulties. '.repeat(40);
    assert.equal(salvageConsentPrefixedStoredText({ fullText: clean, wrongFullText: CONSENT_LAYER + LONG, wrongShow: true }), clean);
  });
  it('returns null for a plain review and for a consent block with no article after it', () => {
    assert.equal(salvageConsentPrefixedStoredText({ fullText: LONG }), null);
    assert.equal(salvageConsentPrefixedStoredText({ fullText: CONSENT_LAYER }), null);
  });
  it('a flagged file with a consent-captured quarantine enters the drain', () => {
    assert.equal(storedTextNeedsConsentRefetch({ fullText: LONG, wrongFullText: CONSENT_LAYER + LONG, wrongShow: true }), true);
    assert.equal(storedTextNeedsConsentRefetch({ fullText: LONG, wrongFullText: CONSENT_LAYER + LONG }), false);
  });
});

describe('salvageConsentPrefixedStoredText once per file', () => {
  const { salvageConsentPrefixedStoredText } = require('../../scripts/lib/consent-refetch');
  const { salvageSourceHash } = require('../../scripts/lib/consent-refetch');
  it('returns null once the stored text it would verify is stamped, and re-opens when the text changes', () => {
    const LONG = ARTICLE + ' ' + ARTICLE;
    const d = { fullText: CONSENT_LAYER + LONG };
    assert.ok(salvageConsentPrefixedStoredText(d));
    d.consentSalvageVerifiedHash = salvageSourceHash(d);
    assert.equal(salvageConsentPrefixedStoredText(d), null);
    d.fullText = CONSENT_LAYER + LONG + ' More.';
    assert.ok(salvageConsentPrefixedStoredText(d));
  });
});

describe('applyVerifiedRetryOutcome', () => {
  const { applyVerifiedRetryOutcome } = require('../../scripts/lib/consent-refetch');
  const clean = { isValid: true, wrongArticle: false, wrongProduction: false, confidence: 'high' };
  const NOW = '2026-09-29T00:00:00.000Z';
  it('clears a verifier-set wrongShow with the auto-clear breadcrumb and keeps wrongFullText', () => {
    const d = { wrongShow: true, wrongShowReason: 'Collector LLM: not a review', wrongFullText: 'x', contentVerification: clean, wrongShowRetryAt: 'old' };
    const out = applyVerifiedRetryOutcome(d, NOW);
    assert.equal(out.clearedWrongShow, true);
    assert.equal(d.wrongShow, undefined);
    assert.equal(d.wrongShowAutoCleared.length > 0, true);
    assert.equal(d.wrongShowAutoClearedAt, NOW);
    assert.equal(d.wrongFullText, 'x');
    assert.equal(d.wrongShowRetryAt, undefined);
  });
  it('never clears a cross-show / human / scorer wrongShow', () => {
    for (const reason of ['Cross-show collision', undefined, 'manual']) {
      const d = { wrongShow: true, wrongShowReason: reason, contentVerification: clean };
      assert.equal(applyVerifiedRetryOutcome(d, NOW).clearedWrongShow, false);
      assert.equal(d.wrongShow, true);
    }
  });
  it('clears a verifier-set wrongProduction only on a high-confidence right-production verdict', () => {
    const d = { wrongProduction: true, wrongProductionReason: 'Collector LLM: wrong production (high)', contentVerification: clean };
    assert.equal(applyVerifiedRetryOutcome(d, NOW).clearedWrongProduction, true);
    assert.equal(d.wrongProduction, undefined);
    assert.equal(d.wrongProductionAutoClearedAt, NOW);
    const m = { wrongProduction: true, wrongProductionReason: 'Collector LLM: x', contentVerification: { ...clean, confidence: 'medium' } };
    assert.equal(applyVerifiedRetryOutcome(m, NOW).clearedWrongProduction, false);
  });
  it('a failed verdict starts the cooldown and clears nothing', () => {
    const d = { wrongShow: true, wrongShowReason: 'Collector LLM: x', contentVerification: { ...clean, isValid: false } };
    applyVerifiedRetryOutcome(d, NOW);
    assert.equal(d.wrongShow, true);
    assert.equal(d.wrongShowRetryAt, NOW);
  });
});

describe('verdictClearsReview', () => {
  const { verdictClearsReview, applyVerifiedRetryOutcome } = require('../../scripts/lib/consent-refetch');
  const base = { isValid: false, wrongArticle: false, articleType: 'review', articleTypeConfidence: 'high', wrongProduction: true, confidence: 'low' };
  it('a high-confidence review with only a low-confidence production doubt clears', () => {
    assert.equal(verdictClearsReview(base), true);
  });
  it('a medium/high production doubt does not', () => {
    assert.equal(verdictClearsReview({ ...base, confidence: 'medium' }), false);
    assert.equal(verdictClearsReview({ ...base, confidence: 'high' }), false);
  });
  it('a non-review or low article-type confidence does not', () => {
    assert.equal(verdictClearsReview({ ...base, articleType: 'news' }), false);
    assert.equal(verdictClearsReview({ ...base, articleTypeConfidence: 'low' }), false);
    assert.equal(verdictClearsReview({ ...base, wrongArticle: true }), false);
  });
  it('releases a "not a review" wrongShow but never the wrongProduction on a low-confidence doubt', () => {
    const d = { wrongShow: true, wrongShowReason: 'Collector LLM: not a review', wrongProduction: true, wrongProductionReason: 'Collector LLM: x', contentVerification: base };
    const out = applyVerifiedRetryOutcome(d, '2026-09-29T00:00:00Z');
    assert.equal(out.clearedWrongShow, true);
    assert.equal(out.clearedWrongProduction, false);
    assert.equal(d.wrongProduction, true);
  });
});
