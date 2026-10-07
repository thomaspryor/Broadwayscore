/**
 * Guarded review-field merge (Notion 39b637c5-416f-815e).
 *
 * The rebuild's stale-filename cleanup passes fold a mis-named file into its
 * canonical sibling. Blind copying transferred rejectionReason + an interview
 * URL from a flagged tombstone into a live scored row (my-neighbour-totoro
 * theupcoming, 2026-07-12), silently excluding it from reviews.json.
 *
 * Includes a drift test: every `data.<flag>` exclusion that
 * review-guards.js::isIncludableForRebuild gates on must be covered by
 * isExclusionFlagged (the canonical predicate itself needs show/filePath
 * context, so the lib mirrors its data-only flag checks — this test is the
 * enforcement that the mirror stays complete).
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
const { mergeUniqueReviewFields, isExclusionFlagged, isTransferableField, hasOperatorAssertion } =
  require(resolve(ROOT, 'scripts/lib/merge-review-fields.js'));

describe('mergeUniqueReviewFields', () => {
  test('totoro shape: flagged source never folds into unflagged scored target', () => {
    const target = {
      outletId: 'theupcoming', criticName: 'Unknown', url: null,
      stagedoorExcerpt: 'Genuinely enticing', aggregatorStars: '4/5 stars',
      assignedScore: 82, scoreStatus: 'SCORED',
    };
    const source = {
      outletId: 'theupcoming', criticName: 'Unknown',
      url: 'https://www.theupcoming.co.uk/2025/03/20/interview-not-a-review/',
      rejectionReason: 'not_a_review', rejectedBy: 'manual-registry-merge',
    };
    const r = mergeUniqueReviewFields(target, source);
    assert.strictEqual(r.action, 'skip-flagged-source');
    assert.strictEqual(target.url, null);
    assert.strictEqual(target.rejectionReason, undefined);
  });

  test('rejectedAt-only tombstone (rejectionReason later cleared) is still refused', () => {
    const target = { outletId: 'x', url: null };
    const r = mergeUniqueReviewFields(target, {
      rejectedAt: '2026-04-20T00:00:00Z',
      url: 'https://x.test/rejected-article', fullText: 'rejected body',
    });
    assert.strictEqual(r.action, 'skip-flagged-source');
    assert.strictEqual(target.url, null);
    assert.strictEqual(target.fullText, undefined);
  });

  test('flagged source is refused even when the target is also flagged (URL must not migrate)', () => {
    const target = { outletId: 'x', wrongProduction: true, url: null };
    const r = mergeUniqueReviewFields(target, {
      wrongProduction: true, url: 'https://x.test/other-production-review',
    });
    assert.strictEqual(r.action, 'skip-flagged-source');
    assert.strictEqual(target.url, null);
  });

  test('manually-cleared source is not merged away: its clear cannot transfer, so deleting it undoes the human decision', () => {
    // Clear breadcrumbs never transfer (rule 2), so merging then unlinking a
    // hand-cleared file silently dropped the clear. BRO-4185 follow-up:
    // Catarina / London Unattached (2026-09-27).
    const target = { outletId: 'x', url: null };
    const r = mergeUniqueReviewFields(target, {
      wrongProduction: true, wrongProductionManualClear: true,
      url: 'https://x.test/r', publishDate: '2026-07-01',
    });
    assert.strictEqual(r.action, 'skip-protected-source');
    assert.strictEqual(r.changed, false);
    assert.strictEqual(target.url, null, 'target untouched');
  });

  test('Catarina shape: allowEarlyDate + manualClearNote source is kept; sibling left alone', () => {
    const target = { outletId: 'london-unattached', criticName: 'Madeleine Morrow', fullText: 'x'.repeat(2000) };
    const source = {
      outletId: 'london-unattached', criticName: 'Madeleine Morrow', allowEarlyDate: true,
      wrongShow: false, manualClearNote: 'BRO-4185: hand-cleared', fullText: 'y'.repeat(2000),
    };
    const r = mergeUniqueReviewFields(target, source);
    assert.strictEqual(r.action, 'skip-protected-source');
    assert.deepStrictEqual(Object.keys(target).sort(), ['criticName', 'fullText', 'outletId']);
  });

  test('unflagged source merges only missing fields; explicit false/0 on target preserved', () => {
    const target = { outletId: 'telegraph', url: null, excerpt: 'kept', isFullReview: false };
    const source = { outletId: 'telegraph', url: 'https://telegraph.co.uk/r', excerpt: 'ignored', isFullReview: true, publishDate: '2026-07-01' };
    const r = mergeUniqueReviewFields(target, source);
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.changed, true);
    assert.strictEqual(target.url, 'https://telegraph.co.uk/r');
    assert.strictEqual(target.excerpt, 'kept');
    assert.strictEqual(target.isFullReview, false, 'explicit false is not clobbered');
    assert.strictEqual(target.publishDate, '2026-07-01');
  });

  test('no-change merge reports changed=false', () => {
    const target = { outletId: 'x', url: 'https://x.test/r' };
    const r = mergeUniqueReviewFields(target, { outletId: 'x', url: 'https://x.test/r' });
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.changed, false);
    assert.strictEqual(target.mergedDuplicateUrls, undefined);
  });
});

describe('isTransferableField', () => {
  test('flag/pointer/verdict/operator-decision families never transfer', () => {
    for (const k of [
      'wrongProduction', 'wrongProductionManualClear', 'wrongShow', 'wrongUrl', 'wrongAttribution',
      'rejectionReason', 'rejectedAt', 'rejectedBy',
      'duplicateOf', 'duplicateTextOf', 'duplicateClearReason',
      'suspectedMisattribution', 'isRoundupArticle',
      'isNonReview', 'isNotReview', 'nonReviewFlag', 'nonReviewContent',
      'fabricatedEntry', 'isSyndicatedDuplicate', 'crossOutletDuplicate',
      'bwwAggregatorAmbiguous', 'contentVerification', 'contentVerificationPromoted',
      'flaggedForReview', 'flagReason', 'incompleteReason', 'incompleteDetail',
      'manualContentTier', 'humanReviewScore', 'humanReviewedWrongProduction',
      'allowEarlyDate', '_locked',
    ]) {
      assert.strictEqual(isTransferableField(k), false, `${k} must not transfer`);
    }
  });
  test('content fields transfer', () => {
    for (const k of ['url', 'fullText', 'excerpt', 'publishDate', 'aggregatorStars', 'criticName', 'llmScore', 'sources']) {
      assert.strictEqual(isTransferableField(k), true, `${k} must transfer`);
    }
  });
});

describe('drift vs canonical predicate', () => {
  test('every data-only flag isIncludableForRebuild excludes on is covered by isExclusionFlagged', () => {
    const guardsSrc = readFileSync(resolve(ROOT, 'scripts/lib/review-guards.js'), 'utf8');
    const start = guardsSrc.indexOf('function isIncludableForRebuild');
    assert.ok(start > 0, 'isIncludableForRebuild not found');
    // function body ends at the next top-level function declaration
    const end = guardsSrc.indexOf('\nfunction ', start + 10);
    const body = guardsSrc.slice(start, end > 0 ? end : undefined);
    // Boolean exclusion flags gated as `data.<flag> === true`
    const flags = new Set([...body.matchAll(/data\.(\w+) === true/g)].map((m) => m[1]));
    // plus the truthy-gated exclusion signals
    for (const f of ['duplicateOf', 'rejectionReason', 'rejectedAt']) flags.add(f);
    // Signals that are conditions/overrides, not exclusion flags themselves
    const NOT_FLAGS = new Set([
      'wrongProductionManualClear', 'wrongProductionOverride', 'humanReviewedWrongProduction',
      'fullText', // used in the duplicateOf circular-recovery branch
    ]);
    const uncovered = [];
    for (const flag of flags) {
      if (NOT_FLAGS.has(flag)) continue;
      const fixture = flag === 'wrongArticle'
        ? { contentVerification: { wrongArticle: true, confidence: 'high' } }
        : { [flag]: flag === 'rejectionReason' ? 'not_a_review' : flag === 'rejectedAt' ? '2026-01-01T00:00:00Z' : flag === 'duplicateOf' ? 'x.json' : true };
      if (!isExclusionFlagged(fixture)) uncovered.push(flag);
    }
    assert.deepStrictEqual(uncovered, [],
      `isIncludableForRebuild gates on flags isExclusionFlagged misses: ${uncovered.join(', ')} — add them to scripts/lib/merge-review-fields.js`);
  });
});

describe('wiring', () => {
  test('rebuild-all-reviews.js consolidation passes use the guarded merge', () => {
    // The outlet-mismatch pass moved to scripts/lib/outlet-mismatch-heal.js
    // (runOutletMismatchCleanup, 2026-09-29); the --unknown pass stays inline.
    const contents = readFileSync(resolve(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
    const heal = readFileSync(resolve(ROOT, 'scripts/lib/outlet-mismatch-heal.js'), 'utf8');
    assert.match(contents, /require\(['"]\.\/lib\/merge-review-fields['"]\)/);
    assert.match(contents, /runOutletMismatchCleanup\s*\(/);
    assert.match(heal, /require\(['"]\.\/merge-review-fields['"]\)/);
    const calls = (contents.match(/mergeUniqueReviewFields\s*\(/g) || []).length
      + (heal.match(/mergeUniqueReviewFields\s*\(/g) || []).length;
    assert.ok(calls >= 2, `both cleanup passes must use the guarded merge; found ${calls}`);
    assert.ok(!/for \(const \[key, val\] of Object\.entries\(d\)\)/.test(contents),
      'a consolidation pass still blind-copies fields — route it through mergeUniqueReviewFields');
  });
  test('backfill merge sites use the guard', () => {
    const archiveOrg = readFileSync(resolve(ROOT, 'scripts/backfill-critics-archive-org.js'), 'utf8');
    assert.match(archiveOrg, /mergeUniqueReviewFields\s*\(/);
    const htmlOverride = readFileSync(resolve(ROOT, 'scripts/backfill-html-override-rename.js'), 'utf8');
    assert.match(htmlOverride, /isTransferableField\s*\(/);
  });
  test('validator skips rejection-flagged tombstones (no duplicate_review accumulation)', () => {
    // Asserts the BEHAVIOUR, not the source text. This used to grep for the literal
    // inline chain `data.rejectionReason || data.suspectedMisattribution`, which broke
    // the moment that chain was extracted into the shared canonical predicate (#1002)
    // even though the behaviour was unchanged — a source-shape assertion that fails on
    // a legitimate refactor while proving nothing about what the validator actually
    // does. The predicate check below is strictly stronger, and the wiring check keeps
    // the guarantee that the validator still consults it.
    const { isSkippedByValidator } = require(resolve(ROOT, 'scripts/lib/aggregator-url-latent.js'));

    assert.equal(isSkippedByValidator({ rejectionReason: 'not_a_review' }), true,
      'rejection-flagged tombstones must be skipped — the consolidation passes leave them in place');
    assert.equal(isSkippedByValidator({ suspectedMisattribution: true }), true,
      'suspected-misattribution tombstones must be skipped for the same reason');
    assert.equal(isSkippedByValidator({}), false,
      'a clean review must still be validated');

    const validator = readFileSync(resolve(ROOT, 'scripts/validate-review-texts.js'), 'utf8');
    assert.match(validator, /isSkippedByValidator\(data\)/,
      'validate-review-texts must route its skip decision through the canonical predicate');
  });
});

describe('hasOperatorAssertion', () => {
  test('recognises each human-decision marker', () => {
    for (const d of [
      { wrongProductionManualClear: true }, { wrongShowManualClear: true }, { allowEarlyDate: true },
      { allowTourSignal: true }, { manualContentTier: 'complete' }, { humanReviewScore: 70 },
      { humanReviewedWrongProduction: false }, { manualClearNote: 'x' },
    ]) assert.strictEqual(hasOperatorAssertion(d), true, JSON.stringify(d));
  });
  test('ordinary machine-written files carry no assertion', () => {
    for (const d of [
      {}, null, { allowEarlyDate: false }, { humanReviewedWrongProduction: true },
      { wrongProduction: true, wrongProductionReason: 'Collector LLM' }, { manualClearNote: '' },
    ]) assert.strictEqual(hasOperatorAssertion(d), false, JSON.stringify(d));
  });
});
