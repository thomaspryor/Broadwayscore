/**
 * BRO-1431: ingest-urls.js's body-injection path (createOrMergeReviewFile's
 * merge branch, in scripts/lib/review-file-writer.js) must neutralize stale
 * exclusion state when a stub's body transitions from empty/short to
 * substantial — otherwise a review with real fullText stays silently
 * suppressed by flags/verdicts stamped against the OLD (empty/wrong) body.
 *
 * Evidence: 2026-07-13 Met opera backfill — 7 bachtrack revival reviews got
 * real bodies injected into stubs carrying wrongProduction:true (stamped by
 * Guard A's market-routing "ambiguous-production" call with no body to judge
 * from). All 7 stayed excluded until manually cleared with the full
 * protection-field set (memory/feedback_manual_review_protection_fields.md).
 *
 * Per CLAUDE.md §15, the decision logic is extracted to
 * scripts/lib/stale-flag-neutralization.js and required here — this file
 * tests the REAL function, not a restatement of its logic. The "integration"
 * describe block below exercises the actual write chokepoint
 * (createOrMergeReviewFile) ingest-urls.js calls, not just the predicate in
 * isolation — see ingest-review-from-url.test.mjs's docblock for why a
 * predicate-only test suite can miss a wiring bug.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  bodyBecameSubstantial,
  isDateBasedWrongProduction,
  isHumanClearedWrongProduction,
  neutralizeStaleFlagsOnBodyReplacement,
  BODY_STALE_THRESHOLD,
  BODY_SUBSTANTIAL_THRESHOLD,
} = require('./lib/stale-flag-neutralization.js');

const SHORT_BODY = 'a'.repeat(50);
const SUBSTANTIAL_BODY = 'This is a real review of the production. '.repeat(80); // ~3400 chars

describe('stale-flag-neutralization: bodyBecameSubstantial (pure predicate)', () => {
  test('empty -> substantial qualifies', () => {
    assert.equal(bodyBecameSubstantial('', SUBSTANTIAL_BODY), true);
  });

  test('short -> substantial qualifies', () => {
    assert.equal(bodyBecameSubstantial(SHORT_BODY, SUBSTANTIAL_BODY), true);
  });

  test('substantial -> substantial (metadata-only re-save) does not qualify', () => {
    assert.equal(bodyBecameSubstantial(SUBSTANTIAL_BODY, SUBSTANTIAL_BODY), false);
  });

  test('empty -> still short does not qualify', () => {
    assert.equal(bodyBecameSubstantial('', SHORT_BODY), false);
  });

  test('threshold boundary: exactly at BODY_STALE_THRESHOLD is not "stale" (not < threshold)', () => {
    const before = 'x'.repeat(BODY_STALE_THRESHOLD);
    const after = 'x'.repeat(BODY_SUBSTANTIAL_THRESHOLD);
    assert.equal(bodyBecameSubstantial(before, after), false);
  });

  test('threshold boundary: exactly at BODY_SUBSTANTIAL_THRESHOLD qualifies', () => {
    const after = 'x'.repeat(BODY_SUBSTANTIAL_THRESHOLD);
    assert.equal(bodyBecameSubstantial('', after), true);
  });
});

describe('stale-flag-neutralization: isDateBasedWrongProduction (content-independent carve-out)', () => {
  test('Guard J/K "Auto-flagged: URL date" note is date-based — must never be cleared by body arrival', () => {
    assert.equal(isDateBasedWrongProduction({
      wrongProductionNote: 'Auto-flagged: URL date 2019-04-24 is 213d after show closed (2018-09-16). BWW cross-production',
    }), true);
  });

  test('rebuild pre-opening/date-guard prefixes are date-based', () => {
    for (const note of ['Pre-opening guard: review dated 2024-05-29 is 60+ days before', 'Date guard: review 2019-04-24 is 213d after', 'Dateless show: no opening date on record', 'Tour transfer: reviewed a touring leg']) {
      assert.equal(isDateBasedWrongProduction({ wrongProductionNote: note }), true, note);
    }
  });

  test('collect-review-texts.js anticipatory-gate reason is date-based', () => {
    assert.equal(isDateBasedWrongProduction({ wrongProductionReason: 'anticipatory_pre_opening_post' }), true);
  });

  test('market-routing "ambiguous-production" reason is content-derived, not date-based', () => {
    assert.equal(isDateBasedWrongProduction({ wrongProductionReason: 'ambiguous-production' }), false);
  });

  test('no basis at all is not date-based', () => {
    assert.equal(isDateBasedWrongProduction({}), false);
  });
});

describe('stale-flag-neutralization: isHumanClearedWrongProduction', () => {
  test('manual-clear signals are all honored', () => {
    assert.equal(isHumanClearedWrongProduction({ wrongProductionManualClear: true }), true);
    assert.equal(isHumanClearedWrongProduction({ wrongProductionOverride: true }), true);
    assert.equal(isHumanClearedWrongProduction({ humanReviewedWrongProduction: false }), true);
    assert.equal(isHumanClearedWrongProduction({ wrongProductionProvenance: 'manual' }), true);
    assert.equal(isHumanClearedWrongProduction({ humanReviewScore: 82 }), true);
  });

  test('humanReviewedWrongProduction === true (human CONFIRMED genuinely wrong) is also untouchable', () => {
    // Codex adversarial review (BRO-1431 ship-check): the field name means
    // "a human reviewed this", not "a human cleared it" — === true is a real
    // human verdict in the OTHER direction and must be just as protected.
    assert.equal(isHumanClearedWrongProduction({ humanReviewedWrongProduction: true, wrongProduction: true }), true);
  });

  test('no signals present is not human-cleared', () => {
    assert.equal(isHumanClearedWrongProduction({ wrongProduction: true }), false);
  });
});

describe('stale-flag-neutralization: neutralizeStaleFlagsOnBodyReplacement (pure mutation)', () => {
  test('clears a content-derived wrongProduction flag + stale contentVerification on empty->substantial transition', () => {
    const record = {
      fullText: SUBSTANTIAL_BODY,
      wrongProduction: true,
      wrongProductionReason: 'ambiguous-production',
      contentVerification: { isValid: false, wrongArticle: true, reasoning: 'old body was garbage', confidence: 'high', verifiedAt: '2026-01-01T00:00:00Z', verifiedBy: 'llm:test', isFilmTv: false },
    };
    const cleared = neutralizeStaleFlagsOnBodyReplacement(record, '');

    assert.deepEqual(cleared.sort(), ['contentVerification', 'wrongProduction']);
    assert.equal(record.wrongProduction, false);
    assert.notEqual(record.wrongProductionReason, 'ambiguous-production', 'stale content-derived reason must not survive verbatim');
    assert.match(record.wrongProductionReason, /^superseded:/);
    assert.equal(typeof record.wrongProductionAutoCleared, 'string');
    assert.match(record.wrongProductionAutoCleared, /body replaced/);
    assert.ok(record.wrongProductionAutoClearedAt);
    // Only the OLD-body-verdict fields die; isFilmTv (article-type metadata,
    // not a wrong-article/wrong-production verdict) survives.
    assert.equal(record.contentVerification.isValid, undefined);
    assert.equal(record.contentVerification.wrongArticle, undefined);
    assert.equal(record.contentVerification.isFilmTv, false);
  });

  test('does NOT clear a date-based wrongProduction flag even after body replacement', () => {
    const record = {
      fullText: SUBSTANTIAL_BODY,
      wrongProduction: true,
      wrongProductionNote: 'Auto-flagged: URL date 2019-04-24 is 213d after show closed (2018-09-16). BWW cross-production',
    };
    const cleared = neutralizeStaleFlagsOnBodyReplacement(record, '');
    assert.equal(cleared.includes('wrongProduction'), false);
    assert.equal(record.wrongProduction, true);
    assert.equal(record.wrongProductionNote, 'Auto-flagged: URL date 2019-04-24 is 213d after show closed (2018-09-16). BWW cross-production');
  });

  test('does NOT clear a manually-cleared wrongProduction state', () => {
    const record = {
      fullText: SUBSTANTIAL_BODY,
      wrongProduction: true,
      wrongProductionReason: 'ambiguous-production',
      wrongProductionManualClear: true,
    };
    const cleared = neutralizeStaleFlagsOnBodyReplacement(record, '');
    assert.equal(cleared.includes('wrongProduction'), false);
    assert.equal(record.wrongProduction, true);
  });

  test('no-op when the body did not become substantial (short metadata-only update)', () => {
    const record = { fullText: SHORT_BODY, wrongProduction: true, wrongProductionReason: 'ambiguous-production' };
    const cleared = neutralizeStaleFlagsOnBodyReplacement(record, '');
    assert.deepEqual(cleared, []);
    assert.equal(record.wrongProduction, true);
  });

  test('no-op when there is nothing to clear (clean stub gaining a body)', () => {
    const record = { fullText: SUBSTANTIAL_BODY };
    const cleared = neutralizeStaleFlagsOnBodyReplacement(record, '');
    assert.deepEqual(cleared, []);
  });

  test('does NOT clear when a human confirmed genuinely wrong production (humanReviewedWrongProduction:true)', () => {
    const record = {
      fullText: SUBSTANTIAL_BODY,
      wrongProduction: true,
      wrongProductionReason: 'ambiguous-production',
      humanReviewedWrongProduction: true,
    };
    const cleared = neutralizeStaleFlagsOnBodyReplacement(record, '');
    assert.deepEqual(cleared, []);
    assert.equal(record.wrongProduction, true);
  });

  test('leaves a manual-entry write\'s OWN fresh contentVerification alone (does not strip it as "stale")', () => {
    // Codex adversarial review (BRO-1431 ship-check): manual-review-fields.js's
    // operator-trust path writes contentVerification:{wrongProduction:false,
    // wrongArticle:false} in the SAME write that fills in the body, alongside
    // wrongProductionManualClear:true. Blind CV-field deletion must not run
    // here just because the body also transitioned empty->substantial.
    const record = {
      fullText: SUBSTANTIAL_BODY,
      wrongProduction: false,
      wrongProductionManualClear: true,
      humanReviewedWrongProduction: false,
      contentVerification: { wrongProduction: false, wrongArticle: false },
    };
    const cleared = neutralizeStaleFlagsOnBodyReplacement(record, '');
    assert.deepEqual(cleared, []);
    assert.deepEqual(record.contentVerification, { wrongProduction: false, wrongArticle: false });
  });
});

// ─── Integration: the real write chokepoint ingest-urls.js calls ───────────

function withTempReviewTextsDir(showId, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-urls-bro-1431-test-'));
  fs.mkdirSync(path.join(tmp, showId), { recursive: true });
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('createOrMergeReviewFile integration (BRO-1431 wiring through the shared writer)', () => {
  const SHOW_ID = 'the-fear-of-13-2026'; // real show fixture used by review-file-writer-bww-reviews-guard.test.mjs

  test('ingesting a real body into a wrongProduction/contentVerification/contentTier=invalid stub yields a scoreable, unflagged review', () => {
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('./lib/review-file-writer.js');
      const filepath = path.join(tmp, SHOW_ID, 'vulture--jane-critic.json');
      const url = 'https://www.vulture.com/article/the-fear-of-13-review.html';
      fs.writeFileSync(filepath, JSON.stringify({
        showId: SHOW_ID,
        outletId: 'vulture',
        outlet: 'Vulture',
        criticName: 'Jane Critic',
        url,
        source: 'market-routing-test',
        sources: ['market-routing-test'],
        fullText: '',
        wrongProduction: true,
        wrongProductionReason: 'ambiguous-production',
        contentTier: 'invalid',
        contentVerification: {
          isValid: false,
          wrongArticle: true,
          reasoning: 'old body was garbage',
          confidence: 'high',
          verifiedAt: '2026-01-01T00:00:00Z',
          verifiedBy: 'llm:test',
        },
      }, null, 2));

      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'vulture',
        outlet: 'Vulture',
        criticName: 'Jane Critic',
        url,
        source: 'ingest-urls',
        fields: { fullText: SUBSTANTIAL_BODY, textFetchedAt: '2026-07-13T00:00:00.000Z' },
      }, { reviewTextsDir: tmp });

      assert.equal(result.action, 'updated', `expected an updated write, got ${result.action} (${result.reason})`);
      const written = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

      // flag transition
      assert.equal(written.wrongProduction, false, 'wrongProduction must be cleared once a real body replaces the empty stub');
      assert.notEqual(written.wrongProductionReason, 'ambiguous-production', 'stale content-derived reason must not survive verbatim on disk');
      assert.match(written.wrongProductionAutoCleared || '', /body replaced/);

      // contentVerification transition
      assert.equal(written.contentVerification.isValid, undefined, 'stale isValid verdict must not survive');
      assert.equal(written.contentVerification.wrongArticle, undefined, 'stale wrongArticle verdict must not survive');

      // contentTier transition — reclassified from the real body, no longer 'invalid'
      assert.notEqual(written.contentTier, 'invalid');

      // the review is now scoreable input, not still carrying the fetched body's placeholder
      assert.equal(written.fullText, SUBSTANTIAL_BODY);
    });
  });

  test('a date-based wrongProduction flag survives the same body-replacement merge', () => {
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('./lib/review-file-writer.js');
      const filepath = path.join(tmp, SHOW_ID, 'vulture--jane-critic.json');
      const url = 'https://www.vulture.com/article/the-fear-of-13-review.html';
      fs.writeFileSync(filepath, JSON.stringify({
        showId: SHOW_ID,
        outletId: 'vulture',
        outlet: 'Vulture',
        criticName: 'Jane Critic',
        url,
        source: 'market-routing-test',
        sources: ['market-routing-test'],
        fullText: '',
        wrongProduction: true,
        wrongProductionNote: 'Auto-flagged: URL date 2019-04-24 is 213d after show closed (2018-09-16). BWW cross-production',
      }, null, 2));

      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'vulture',
        outlet: 'Vulture',
        criticName: 'Jane Critic',
        url,
        source: 'ingest-urls',
        fields: { fullText: SUBSTANTIAL_BODY },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected a write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      assert.equal(written.wrongProduction, true, 'a date-derived flag must not be cleared by new body text');
    });
  });

  test('a manually-cleared wrongProduction=true state is left untouched by body replacement', () => {
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('./lib/review-file-writer.js');
      const filepath = path.join(tmp, SHOW_ID, 'vulture--jane-critic.json');
      const url = 'https://www.vulture.com/article/the-fear-of-13-review.html';
      fs.writeFileSync(filepath, JSON.stringify({
        showId: SHOW_ID,
        outletId: 'vulture',
        outlet: 'Vulture',
        criticName: 'Jane Critic',
        url,
        source: 'market-routing-test',
        sources: ['market-routing-test'],
        fullText: '',
        wrongProduction: true,
        wrongProductionReason: 'ambiguous-production',
        wrongProductionManualClear: true,
      }, null, 2));

      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'vulture',
        outlet: 'Vulture',
        criticName: 'Jane Critic',
        url,
        source: 'ingest-urls',
        fields: { fullText: SUBSTANTIAL_BODY },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected a write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      assert.equal(written.wrongProduction, true, 'a human-cleared/reasserted flag must never be auto-cleared');
    });
  });
});
