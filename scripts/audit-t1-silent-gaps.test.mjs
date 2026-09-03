import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifySilentGap } = require('./lib/t1-silent-gap.js');

const NOW = new Date('2026-08-31T20:00:00Z');
const classify = (file, over = {}) =>
  classifySilentGap({ file, show: {}, tier: 2, outletScored: false, now: NOW, ...over });

// BRO-71: 16-item back-catalogue sweep remainder, re-derived to 10 live gaps
// on 2026-08-31. Each fixture below is the real per-item failure shape found
// during triage and the fix applied — a regression test for the SPECIFIC
// population this card worked, distinct from t1-silent-gap.test.mjs's
// synthetic 2026-07-18 incident fixtures.

test('Playbill "Verdict" roundup class (girl-interrupted, celebrity-autobiography): ' +
  'content landed in the wrong field (wrongFullText) after a URL-correction clear, ' +
  'leaving fullText null — an ordinary empty-body/stub gap (this fixture\'s URL slug ' +
  'does NOT match isRoundupUrl\'s patterns, so isRoundupPageAsReview never fires here; ' +
  'the eventual not_a_review verdict below comes from the real ensemble re-reading the ' +
  're-ingested text, the same verdict it already gave this exact Playbill "what are/did ' +
  'critics think" template on caroline-off-broadway-2026, not from roundup-URL matching)', () => {
  const stuckAfterUrlCorrection = {
    url: 'https://playbill.com/article/what-are-reviews-saying-about-girl-interrupted',
    contentTier: 'stub',
    fullText: null,
    wrongFullText: 'Girl, Interrupted officially opened Off-Broadway... 1 Minute Critic (Matthew Wexler) ... Playbill will continue to update this list as reviews come in.',
    needsRefetch: true,
  };
  assert.deepEqual(classify(stuckAfterUrlCorrection), { type: 'empty-body', recoverable: true });

  const reingestedAndClassified = {
    url: stuckAfterUrlCorrection.url,
    contentTier: 'complete',
    fullText: 'News The Verdict What Are Reviews Saying About Girl, Interrupted? ... Playbill will continue to update this list as reviews come in.',
    rejectedAt: '2026-08-31T21:00:00Z',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReason: 'not_a_review',
  };
  assert.equal(classify(reingestedAndClassified), null);
});

test('BroadwayWorld preview-mislabeled-as-garbage_text class (trainspotting): ensemble ' +
  'rejectionReasoning already describes a preview/casting piece with no critical ' +
  'evaluation, but rejectionReason was stamped garbage_text (fetch-quality, implies a ' +
  'better fetch could recover a review) instead of not_a_review (editorial, no review ' +
  'exists) — stays a stranded gap until the reason code is corrected', () => {
  const mislabeledGarbageText = {
    url: 'https://www.broadwayworld.com/shows/Trainspotting-The-Musical-336005.html',
    contentTier: 'complete',
    fullText: 'y'.repeat(2000),
    rejectedAt: '2026-07-23T13:11:36.458Z',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReason: 'garbage_text',
  };
  assert.deepEqual(classify(mislabeledGarbageText), { type: 'rejected-unscoreable', recoverable: false });

  const correctedToEditorialExclusion = { ...mislabeledGarbageText, rejectionReason: 'not_a_review' };
  assert.equal(classify(correctedToEditorialExclusion), null);
});

test('video-promo-stuck-in-rescore-loop class (end-of-the-rainbow): includable, ' +
  'truncated text past the unscored grace window with no terminal rejectedAt — a real ' +
  'silent gap (rescoreAttempts kept climbing, 69 in the wild) until the piece is ' +
  'terminally classified not_a_review', () => {
  const stuckInRescoreLoop = {
    url: 'https://www.broadwayworld.com/article/Video-Jinkx-Monsoon-as-Judy-Garland-in-END-OF-THE-RAINBOW-20260520',
    contentTier: 'truncated',
    fullText: 'y'.repeat(700),
    textFetchedAt: '2026-06-28T17:11:11.373Z',
    rescoreAttempts: 69,
    rescoreBlockedReason: 'input_validation_failed:body_too_short',
  };
  assert.deepEqual(classify(stuckInRescoreLoop), { type: 'unscored', recoverable: false });

  const terminallyExcluded = {
    ...stuckInRescoreLoop,
    rejectedAt: '2026-08-31T20:00:00Z',
    rejectedBy: 'manual-triage-bro-71',
    rejectionReason: 'not_a_review',
  };
  assert.equal(classify(terminallyExcluded), null);
});

test('cross-production duplicate-stub class (paranormal-activity-boston-regional): a ' +
  'second, differently-named file for the same outlet+show carries an nyc-theatre ' +
  'excerpt from the WRONG (Broadway) production of a same-titled show — a gap until ' +
  'flagged wrongProduction like its correctly-classified sibling file', () => {
  const contaminatedDuplicateStub = {
    url: null,
    contentTier: 'excerpt',
    fullText: null,
    nycTheatreExcerpt: '"People screamed and jumped in unison just as they would at the cinema."',
  };
  // recoverable=true here just means "no editorial flag blocks a refetch" —
  // the audit script's own isRefetchCandidate gate separately requires a
  // usable URL (this file has none), so it never actually attempts one.
  assert.deepEqual(classify(contaminatedDuplicateStub), { type: 'empty-body', recoverable: true });

  const flaggedWrongProduction = { ...contaminatedDuplicateStub, wrongProduction: true,
    wrongProductionNote: 'nyc-theatre excerpt is verbatim from the Broadway production, cross-attributed by title-only matching.' };
  assert.equal(classify(flaggedWrongProduction), null);
});
