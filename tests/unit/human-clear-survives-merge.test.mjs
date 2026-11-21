/**
 * BRO-5130: a person's "this is a review" clear must survive duplicate merges
 * and lift the stale invalid tier its verdict stamped.
 *
 * Incident (review-texts commit bf5fa64a0, 2026-10-11, "Rebuild Reviews (Fast)"):
 * stranger-things-the-first-shadow-west-end-2023/theatre-weekly--unknown.json
 * carried isNonReview=false + nonReviewManualClear=true (bro-4838-b). The
 * rebuild's stale --unknown pass merged it into theatre-weekly--greg-stewart.json
 * through mergeUniqueReviewFields and deleted it: hasOperatorAssertion did not
 * know nonReviewManualClear, the clear itself never transfers (it describes the
 * file it sits on), and approvedFixes/_urlChangedClear were copied onto a file
 * that never received those edits. The deleted file was the healthy copy (783
 * words, contentTier complete); the survivor was a stale wrongShow/invalid one.
 *
 * Fix: a merge never deletes the file a person cleared (any *ManualClear by
 * pattern, plus the listed human *Override fields), so the clear stays on the file it judged; history
 * fields stop transferring; nonReviewManualClear is PROTECTED; and the matching
 * human clear lifts a stale contentTier 'invalid'.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { mergeUniqueReviewFields, hasOperatorAssertion } =
  require(resolve(ROOT, 'scripts/lib/merge-review-fields.js'));
const { PROTECTED_FIELDS } = require(resolve(ROOT, 'scripts/lib/review-write-guard.js'));
const guards = require(resolve(ROOT, 'scripts/lib/review-guards.js'));

const URL = 'https://theatreweekly.com/review-stranger-things-the-first-shadow-at-the-phoenix-theatre/';
const TEXT = 'A perfectly ordinary review body with more than enough words to pass the text gate.';

// Trimmed from bf5fa64a0^ (the real pair).
function realLoser() {
  return {
    showId: 'stranger-things-the-first-shadow-west-end-2023',
    outlet: 'Theatre Weekly', outletId: 'theatre-weekly', criticName: 'Greg Stewart',
    url: URL, fullText: TEXT, contentTier: 'complete', contentTierReason: 'Full review text',
    originalScore: '5/5 stars', originalScoreNormalized: 100,
    isNonReview: false,
    nonReviewManualClear: true,
    previousUrl: 'https://theatreweekly.com/phoenix-arts-club-launches-stranger-things-upside-down-experience/',
    urlCorrectedFrom: 'https://theatreweekly.com/phoenix-arts-club-launches-stranger-things-upside-down-experience/',
    _urlChangedClear: { cleared: ['wrongShow', 'contentTier'] },
    approvedFixes: [
      { fixId: '8a0ea2b7', field: 'isNonReview', newValue: false },
      { fixId: '8a0ea2b7', field: 'nonReviewManualClear', newValue: true },
    ],
  };
}
function realWinner() {
  return {
    showId: 'stranger-things-the-first-shadow-west-end-2023',
    outlet: 'Theatre Weekly', outletId: 'theatre-weekly', criticName: 'Greg Stewart',
    url: URL, fullText: TEXT, wrongShow: true, wrongShowReason: 'CV-promoted: preview/news piece',
    contentTier: 'invalid', contentTierReason: 'Wrong show', incompleteReason: 'wrong_content',
  };
}

describe('duplicate merge keeps the human clear (defect 1)', () => {
  test('bf5fa64a0 pair: the cleared file is kept, so its clear survives on the file it judged', () => {
    const target = realWinner();
    const before = JSON.stringify(target);
    const source = realLoser();
    const r = mergeUniqueReviewFields(target, source);
    assert.strictEqual(r.action, 'skip-protected-source');
    assert.strictEqual(JSON.stringify(target), before, 'target must be untouched when the source is kept');
    assert.strictEqual(source.nonReviewManualClear, true);
    assert.strictEqual(source.isNonReview, false);
    // The surviving cleared file is includable.
    assert.strictEqual(guards.explainExclusion(source, null, undefined), null);
  });

  test('any *ManualClear counts, including names added after this fix', () => {
    for (const k of ['nonReviewManualClear', 'isNotReviewManualClear', 'listingPageUrlManualClear',
      'someFutureVerdictManualClear', 'wrongShowOverride']) {
      assert.strictEqual(hasOperatorAssertion({ [k]: true }), true, k);
    }
    // Automation-written *Override breadcrumbs are not a person's decision.
    assert.strictEqual(hasOperatorAssertion({ nonReviewOverride: 'Auto-recovered: confidence=7' }), false);
    assert.strictEqual(hasOperatorAssertion({ textQualityOverride: 'batch-fix-2026-01-30' }), false);
    assert.strictEqual(hasOperatorAssertion({ nonReviewManualClear: false }), false);
    assert.strictEqual(hasOperatorAssertion({ nonReviewManualClear: null }), false);
  });

  test("an uncleared merge does not copy the loser's edit history onto the winner", () => {
    const source = realLoser();
    delete source.nonReviewManualClear;
    const target = { outletId: 'theatre-weekly', criticName: 'Greg Stewart', url: URL };
    const r = mergeUniqueReviewFields(target, source);
    assert.strictEqual(r.action, 'merged');
    for (const k of ['approvedFixes', '_urlChangedClear', 'previousUrl', 'urlCorrectedFrom']) {
      assert.strictEqual(target[k], undefined, `${k} must not transfer`);
    }
    assert.strictEqual(target.fullText, TEXT, 'unique content still transfers');
  });

  test('every merge-then-delete caller routes through mergeUniqueReviewFields before unlinking', () => {
    const rebuild = readFileSync(resolve(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
    const unknownPass = rebuild.slice(rebuild.indexOf('Stale --unknown filename cleanup'));
    assert.ok(unknownPass.indexOf('mergeUniqueReviewFields(') < unknownPass.indexOf('fs.unlinkSync(filePath)'));
    const backfill = readFileSync(resolve(ROOT, 'scripts/backfill-unknown-critics.js'), 'utf8');
    const merge = backfill.indexOf('mergeUniqueReviewFields(targetData, u.data)');
    assert.ok(merge > 0 && merge < backfill.indexOf('safeUnlinkReview(u.filePath)'),
      'backfill-unknown-critics phase A must merge (and honor a kept source) before deleting');
  });
});

describe('PROTECTED_FIELDS (defect 2)', () => {
  test('nonReviewManualClear is protected like its sibling clears', () => {
    for (const k of ['nonReviewManualClear', 'isNotReviewManualClear', 'wrongShowManualClear',
      'wrongProductionManualClear', 'wrongArticleManualClear']) {
      assert.ok(PROTECTED_FIELDS.includes(k), k);
    }
  });
});

describe('stale invalid tier lifted by the matching human clear (defect 3)', () => {
  test('wrongShow verdict + wrongShowManualClear is included', () => {
    const d = { fullText: TEXT, wrongShow: true, wrongShowManualClear: true,
      contentTier: 'invalid', contentTierReason: 'Wrong show' };
    assert.strictEqual(guards.explainExclusion(d, null, undefined), null);
    assert.strictEqual(guards.isRejectedNonReview(d), false);
  });

  test('not-a-review verdict + nonReviewManualClear is included', () => {
    // Scorer's pre-opening interview guard (rejectionReason already cleared,
    // BRO-4838) and the collector's non_review invalidation.
    const scorer = { fullText: TEXT, isNonReview: false, nonReviewManualClear: true,
      contentTier: 'invalid', rejectionReason: null, rejectedBy: 'preopening-interview-signal' };
    assert.strictEqual(guards.explainExclusion(scorer, null, undefined), null);
    const collector = { fullText: TEXT, isNonReview: false, nonReviewManualClear: true,
      contentTier: 'invalid', incompleteReason: 'non_review' };
    assert.strictEqual(guards.explainExclusion(collector, null, undefined), null);
    assert.strictEqual(guards.isRejectedNonReview(collector), false);
  });

  test('isNotReviewManualClear and wrongArticleManualClear lift a not-a-review tier too', () => {
    for (const k of ['isNotReviewManualClear', 'wrongArticleManualClear']) {
      const d = { fullText: TEXT, [k]: true, contentTier: 'invalid', incompleteReason: 'non_review' };
      assert.strictEqual(guards.explainExclusion(d, null, undefined), null, k);
    }
  });

  test('a clear only lifts the verdict it answers', () => {
    const wrongVerdict = { fullText: TEXT, nonReviewManualClear: true,
      contentTier: 'invalid', contentTierReason: 'Wrong show' };
    assert.strictEqual(guards.explainExclusion(wrongVerdict, null, undefined), 'contentTierInvalid');
    const garbage = { fullText: TEXT, wrongShowManualClear: true, nonReviewManualClear: true,
      contentTier: 'invalid', contentTierReason: 'Garbage content: nav menu' };
    assert.strictEqual(guards.explainExclusion(garbage, null, undefined), 'contentTierInvalid');
    assert.strictEqual(guards.isRejectedNonReview({ ...garbage, wrongShowManualClear: undefined }), true);
    // Real FT paywall shape: garbage tier plus a wrong_show rejection.
    const paywall = { fullText: TEXT, wrongShowManualClear: true, contentTier: 'invalid',
      contentTierReason: 'Garbage content: Paywall/subscription prompt: "unlock this article"',
      rejectionReason: 'wrong_show' };
    assert.strictEqual(guards.invalidTierClearedByHuman(paywall), false);
    // 'Wrong show' tier over a garbage rejection: the body is garbage, not cleared.
    const garbageRejection = { fullText: TEXT, wrongShowManualClear: true, contentTier: 'invalid',
      contentTierReason: 'Wrong show', rejectionReason: 'garbage_text' };
    assert.strictEqual(guards.invalidTierClearedByHuman(garbageRejection), false);
    const uncleared = { fullText: TEXT, contentTier: 'invalid', contentTierReason: 'Wrong show' };
    assert.strictEqual(guards.explainExclusion(uncleared, null, undefined), 'contentTierInvalid');
  });
});
