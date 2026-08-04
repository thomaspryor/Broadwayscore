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
const { mergeUniqueReviewFields, isExclusionFlagged, isTransferableField } =
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

  test('manually-cleared wrongProduction source merges normally (clear-aware)', () => {
    const target = { outletId: 'x', url: null };
    const r = mergeUniqueReviewFields(target, {
      wrongProduction: true, wrongProductionManualClear: true,
      url: 'https://x.test/r', publishDate: '2026-07-01',
    });
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(target.url, 'https://x.test/r');
    assert.strictEqual(target.wrongProduction, undefined, 'flag fields never transfer');
    assert.strictEqual(target.wrongProductionManualClear, undefined, 'clear breadcrumbs never transfer');
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
    const r = mergeUniqueReviewFields(target, { outletId: 'x', url: 'https://x.test/other' });
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.changed, false);
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
    const contents = readFileSync(resolve(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
    assert.match(contents, /require\(['"]\.\/lib\/merge-review-fields['"]\)/);
    const calls = contents.match(/mergeUniqueReviewFields\s*\(/g) || [];
    assert.ok(calls.length >= 2, `both cleanup passes must use the guarded merge; found ${calls.length}`);
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
