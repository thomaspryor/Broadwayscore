/**
 * Unit tests — same-title/different-year + festival-venue wrongProduction guards
 * (review-guards.js). CI-registered companion to the local Stop-hook fixture in
 * scripts/test-temporal-override-regression.js.
 *
 * Incident (2026-06-15): the 2026 Shakespeare-in-the-Park "Romeo and Juliet"
 * (Delacorte, id romeo-and-juliet-off-broadway-2026, opening 2026-06-11) had its
 * in-window reviews flagged wrongProduction as the 2024 Connor/Zegler Broadway
 * "Romeo + Juliet" — same title, different year — and rendered scoreless on the
 * live site and the newsletter. Two root drivers, two guards:
 *   1. In-window same-title/different-year: a review published inside THIS
 *      production's own preview→opening window is about THIS production.
 *   2. Festival-venue carve-out: "Delacorte/Shakespeare-in-the-Park is not an
 *      Off-Broadway venue" is a taxonomy quibble, never wrongProduction, and not
 *      by itself isValid=false.
 *
 * Refs: Notion 380637c5-416f-8168-8a2e-cb1aad7430bc
 *       memory/feedback_llm_wrongprod_false_positives.md
 *       memory/feedback_same_title_disambiguation.md
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isReviewWithinOwnProductionWindow,
  isSameTitleDifferentYearFalsePositive,
  applyVenueClassificationCarveout,
  isVenueClassificationObjection,
  showHasFestivalVenue,
  reasoningAssertsDifferentProduction,
} = require('../../scripts/lib/review-guards.js');

const RJ_2026 = {
  id: 'romeo-and-juliet-off-broadway-2026',
  title: 'Romeo and Juliet',
  category: 'off-broadway',
  previewsStartDate: '2026-05-22',
  openingDate: '2026-06-11',
  closingDate: '2026-06-28',
  venue: 'Public Theater/Delacorte Theater',
};
const RJ_2024_BROADWAY = {
  id: 'romeo-juliet-2024',
  title: 'Romeo + Juliet',
  category: 'broadway',
  previewsStartDate: '2024-09-26',
  openingDate: '2024-10-24',
  closingDate: '2025-02-16',
  venue: 'Circle in the Square Theatre',
};

describe('isReviewWithinOwnProductionWindow', () => {
  test('opening-day review (with tz) is inside own window', () => {
    assert.strictEqual(isReviewWithinOwnProductionWindow(RJ_2026, '2026-06-12T06:57:12-04:00'), true);
  });
  test('preview-week review is inside own window', () => {
    assert.strictEqual(isReviewWithinOwnProductionWindow(RJ_2026, '2026-05-25'), true);
  });
  test('a couple weeks before previews is inside lead grace', () => {
    assert.strictEqual(isReviewWithinOwnProductionWindow(RJ_2026, '2026-05-08'), true);
  });
  test('2024 Broadway-era date is NOT inside the 2026 window', () => {
    assert.strictEqual(isReviewWithinOwnProductionWindow(RJ_2026, '2024-10-25'), false);
  });
  test('far after close is outside the lag grace', () => {
    assert.strictEqual(isReviewWithinOwnProductionWindow(RJ_2026, '2026-10-01'), false);
  });
  test('missing publishDate → false', () => {
    assert.strictEqual(isReviewWithinOwnProductionWindow(RJ_2026, null), false);
  });
  test('show with no dates → false', () => {
    assert.strictEqual(isReviewWithinOwnProductionWindow({ id: 'x' }, '2026-06-12'), false);
  });
});

describe('isSameTitleDifferentYearFalsePositive', () => {
  test('in-window 2026 review mis-attributed to 2024 Broadway → false positive', () => {
    assert.strictEqual(isSameTitleDifferentYearFalsePositive(RJ_2026, '2026-06-12', RJ_2024_BROADWAY), true);
  });
  test('in-window review with no named target → false positive', () => {
    assert.strictEqual(isSameTitleDifferentYearFalsePositive(RJ_2026, '2026-06-12', null), true);
  });
  test('2024-era review (out of 2026 window) → NOT exempted', () => {
    assert.strictEqual(isSameTitleDifferentYearFalsePositive(RJ_2026, '2024-10-25', RJ_2024_BROADWAY), false);
  });
  test('truly concurrent same-title production near publish → NOT exempted', () => {
    const concurrent = { ...RJ_2024_BROADWAY, previewsStartDate: '2026-06-01', openingDate: '2026-06-10', closingDate: '2026-07-30' };
    assert.strictEqual(isSameTitleDifferentYearFalsePositive(RJ_2026, '2026-06-12', concurrent), false);
  });
});

describe('festival-venue helpers', () => {
  test('Delacorte venue is recognized as festival venue', () => {
    assert.strictEqual(showHasFestivalVenue(RJ_2026), true);
    assert.strictEqual(showHasFestivalVenue({ venue: 'Shubert Theatre' }), false);
  });
  test('indoor Public Theater stages are NOT festival venues (ship-check P0)', () => {
    // The carve-out must not widen to the Public's indoor off-broadway stages.
    assert.strictEqual(showHasFestivalVenue({ venue: 'The Public Theater / Newman Theater' }), false);
    assert.strictEqual(showHasFestivalVenue({ venue: "Joe's Pub at the Public Theater" }), false);
    assert.strictEqual(showHasFestivalVenue({ venue: 'Public Theater - Anspacher Theater' }), false);
  });
  test('venue-classification objection detector', () => {
    assert.strictEqual(isVenueClassificationObjection('Delacorte Theater is NOT an Off-Broadway venue'), true);
    assert.strictEqual(isVenueClassificationObjection('an outdoor summer festival production in Central Park'), true);
    assert.strictEqual(isVenueClassificationObjection('Text is truncated mid-sentence at end'), false);
    assert.strictEqual(isVenueClassificationObjection('Known excerpt does not appear in scraped content'), false);
  });
  test('reasoningAssertsDifferentProduction — year-aware different-production detector', () => {
    // Different year than the show → different production.
    assert.strictEqual(reasoningAssertsDifferentProduction('the 2023 Delacorte staging, not the 2026 one', RJ_2026), true);
    // Comparative production reference.
    assert.strictEqual(reasoningAssertsDifferentProduction('different cast and director', RJ_2026), true);
    assert.strictEqual(reasoningAssertsDifferentProduction('Reviews a different show', RJ_2026), true);
    // Legit R&J reasoning: correct present-tense production, no other year → false.
    assert.strictEqual(reasoningAssertsDifferentProduction(
      'reviewing the Shakespeare in the Park production at the Delacorte Theater in Central Park, not an Off-Broadway indoor production', RJ_2026), false);
    // The show's own year is not a different-production signal.
    assert.strictEqual(reasoningAssertsDifferentProduction('the 2026 Shakespeare in the Park production', RJ_2026), false);
  });
});

describe('applyVenueClassificationCarveout', () => {
  test('venue-only objection clears wrongProduction and restores validity', () => {
    const r = applyVenueClassificationCarveout({
      wrongProduction: true,
      isValid: false,
      issues: ['Review describes Shakespeare in the Park production at Delacorte Theater, which is NOT an Off-Broadway venue'],
      reasoning: 'This is a legitimate review of a contemporary-set Romeo and Juliet at the Delacorte Theater in Central Park, not an Off-Broadway indoor production.',
    }, RJ_2026);
    assert.strictEqual(r.clearedWrongProduction, true);
    assert.strictEqual(r.wrongProduction, false);
    assert.strictEqual(r.restoredValidity, true);
    assert.strictEqual(r.isValid, true);
  });

  test('truncated Delacorte review: wrongProduction cleared, isValid stays false', () => {
    const r = applyVenueClassificationCarveout({
      wrongProduction: true,
      isValid: false,
      issues: [
        'Delacorte Theater is NOT an Off-Broadway venue',
        'Text is truncated mid-sentence at end',
        'Known excerpt does not appear in scraped content',
      ],
      reasoning: 'Legitimate Romeo and Juliet review at the Delacorte / Shakespeare in the Park, but truncated.',
    }, RJ_2026);
    assert.strictEqual(r.clearedWrongProduction, true);
    assert.strictEqual(r.restoredValidity, false, 'genuinely truncated review must not be restored to valid');
    assert.strictEqual(r.isValid, false);
  });

  test('ordinary (non-festival) show is untouched', () => {
    const r = applyVenueClassificationCarveout({
      wrongProduction: true,
      isValid: false,
      issues: ['Review describes the Kennedy Center tryout, not the Broadway production'],
      reasoning: 'This review evaluates the pre-Broadway Kennedy Center run.',
    }, { venue: 'Shubert Theatre', category: 'broadway' });
    assert.strictEqual(r.clearedWrongProduction, false);
    assert.strictEqual(r.wrongProduction, true);
  });

  test('does not clear when reasoning carries a strong different-show marker', () => {
    const r = applyVenueClassificationCarveout({
      wrongProduction: true,
      isValid: false,
      issues: ['Delacorte is not Off-Broadway'],
      reasoning: 'The expected show does not appear in the text — this reviews a different show entirely about an outdoor festival.',
    }, RJ_2026);
    assert.strictEqual(r.clearedWrongProduction, false, 'strong wrong-show signal in reasoning must veto the carve-out');
  });

  test('does NOT clear a genuine different-YEAR review at the same festival stage (ship-check P0)', () => {
    const r = applyVenueClassificationCarveout({
      wrongProduction: true,
      isValid: false,
      issues: ['Delacorte / Central Park venue'],
      reasoning: 'This reviews the 2023 Delacorte Shakespeare in the Park production, not the 2026 staging filed here. Different cast and director.',
    }, RJ_2026);
    assert.strictEqual(r.clearedWrongProduction, false, 'a real prior-year Delacorte review must not be cleared');
  });

  test('does NOT clear when an ISSUE asserts a different show (ship-check P0)', () => {
    const r = applyVenueClassificationCarveout({
      wrongProduction: true,
      isValid: false,
      issues: ['Reviews a different show', 'Delacorte is not an Off-Broadway venue'],
      reasoning: 'This is the Delacorte production in Central Park, not an Off-Broadway house.',
    }, RJ_2026);
    assert.strictEqual(r.clearedWrongProduction, false, 'a wrong-show issue must veto the carve-out even if reasoning is venue-only');
  });

  test('input is not mutated', () => {
    const cv = { wrongProduction: true, isValid: false, issues: ['Delacorte is NOT an Off-Broadway venue'], reasoning: 'legit at Delacorte / Central Park, not off-broadway' };
    applyVenueClassificationCarveout(cv, RJ_2026);
    assert.strictEqual(cv.wrongProduction, true);
    assert.strictEqual(cv.isValid, false);
  });
});
