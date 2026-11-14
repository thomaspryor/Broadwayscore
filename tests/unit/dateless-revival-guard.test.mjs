/**
 * Unit tests for evaluateDatelessRevivalGuard (scripts/lib/date-guard.js) and
 * shouldAutoClearDatelessRevival (scripts/lib/wrong-production-autoclear.js),
 * added 2026-06-17.
 *
 * Background: the dated wrongProduction guards only fire when a review HAS a
 * publishDate. A review with NO usable date escapes them and defaults to
 * includable. On a much-produced (revival) title within the opening window,
 * such reviews are overwhelmingly mis-linked prior-production coverage —
 * e.g. Glengarry Glen Ross West End 2026 (opens 6/17) showing reviews from the
 * 2017 Christian Slater Playhouse production. CV cannot rescue (it false-
 * confirms same-title prior productions), so dateless-on-recent-revival is held.
 *
 * The guard MUST NOT touch dateless reviews on old settled revivals (corpus
 * probe: 1305 dateless includable reviews across 310 multi-prod titles, only
 * ~55 inside the opening window).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { evaluateDatelessRevivalGuard } = require('../../scripts/lib/date-guard.js');
const { shouldAutoClearDatelessRevival } = require('../../scripts/lib/wrong-production-autoclear.js');

const NOW = '2026-06-17';

describe('evaluateDatelessRevivalGuard — pre-opening scope', () => {
  test('Glengarry case: dateless review on a previews-status revival opening today is HELD', () => {
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: false,
      isMultiProductionTitle: true,
      show: { status: 'previews', previewsStartDate: '2026-06-04', openingDate: '2026-06-17' },
      now: NOW,
    });
    assert.equal(v.flag, true);
    assert.equal(v.reason, 'dateless_pre_opening_revival');
  });

  test('future-opening upcoming revival is HELD', () => {
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: false,
      isMultiProductionTitle: true,
      show: { status: 'upcoming', openingDate: '2026-11-24' },
      now: NOW,
    });
    assert.equal(v.flag, true);
  });

  test('FP-safety: already-open recent revival (Joe Turner, opened 53d ago) is NOT held', () => {
    // 4/4 Joe Turner dateless reviews were genuine (WSJ, Culture Sauce). A
    // post-opening hold would drop real flagship coverage — must abstain.
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: false,
      isMultiProductionTitle: true,
      show: { status: 'open', openingDate: '2026-04-25' },
      now: NOW,
    });
    assert.equal(v.flag, false);
  });

  test('FP-safety: revival opened YESTERDAY (open) is NOT held', () => {
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: false,
      isMultiProductionTitle: true,
      show: { status: 'open', openingDate: '2026-06-16' },
      now: NOW,
    });
    assert.equal(v.flag, false);
  });

  test('OLD settled revival (opened 2017) is NOT held — protects the 310', () => {
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: false,
      isMultiProductionTitle: true,
      show: { status: 'open', openingDate: '2017-04-01' },
      now: NOW,
    });
    assert.equal(v.flag, false);
  });

  test('still in previews though opening date already slipped past → HELD (status governs)', () => {
    // Edge: openingDate technically in the past but the show is still flagged
    // previews (open-flip gated on review signal). Pre-opening by status.
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: false,
      isMultiProductionTitle: true,
      show: { status: 'previews', openingDate: '2026-06-10' },
      now: NOW,
    });
    assert.equal(v.flag, true);
  });

  test('NOT a multi-production title (new original play) is NOT held', () => {
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: false,
      isMultiProductionTitle: false,
      show: { status: 'previews', openingDate: '2026-06-17' },
      now: NOW,
    });
    assert.equal(v.flag, false);
  });

  test('review HAS a usable date → guard abstains (dated guard owns it)', () => {
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: true,
      isMultiProductionTitle: true,
      show: { status: 'previews', openingDate: '2026-06-17' },
      now: NOW,
    });
    assert.equal(v.flag, false);
  });

  test('missing show → safe abstain', () => {
    const v = evaluateDatelessRevivalGuard({
      hasUsableDate: false, isMultiProductionTitle: true, show: null, now: NOW,
    });
    assert.equal(v.flag, false);
  });
});

describe('shouldAutoClearDatelessRevival', () => {
  const held = {
    wrongProduction: true,
    wrongProductionReason: 'dateless-revival',
    wrongProductionNote: 'Dateless revival guard: no publishDate on multi-production title within opening window — unverified production (show starts 2026-06-04)',
  };

  test('clears when a usable date now exists', () => {
    assert.equal(shouldAutoClearDatelessRevival(held, { hasUsableDate: true }), true);
  });

  test('clears on human override (allowEarlyDate) even without a date', () => {
    assert.equal(shouldAutoClearDatelessRevival({ ...held, allowEarlyDate: true }, { hasUsableDate: false }), true);
  });

  test('does NOT clear while still dateless and no override', () => {
    assert.equal(shouldAutoClearDatelessRevival(held, { hasUsableDate: false }), false);
  });

  test('never touches a foreign flag (manual / CV / Pre-opening guard)', () => {
    const manual = { wrongProduction: true, wrongProductionReason: 'audit', wrongProductionNote: 'Cross-market: US outlet' };
    assert.equal(shouldAutoClearDatelessRevival(manual, { hasUsableDate: true }), false);
    const preOpen = { wrongProduction: true, wrongProductionNote: 'Pre-opening guard: review dated 2017-11-12 is 90+ days before show' };
    assert.equal(shouldAutoClearDatelessRevival(preOpen, { hasUsableDate: true }), false);
  });

  test('no-op when not flagged', () => {
    assert.equal(shouldAutoClearDatelessRevival({ wrongProduction: false }, { hasUsableDate: true }), false);
  });
});
