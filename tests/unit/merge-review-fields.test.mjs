/**
 * Guarded review-field merge (Notion 39b637c5-416f-815e).
 *
 * The rebuild's stale-filename cleanup passes fold a mis-named file into its
 * canonical sibling. Blind copying transferred rejectionReason + an interview
 * URL from a flagged tombstone into a live scored row (my-neighbour-totoro
 * theupcoming, 2026-07-12), silently excluding it from reviews.json.
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
const { mergeUniqueReviewFields, isExclusionFlagged } =
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

  test('wrongProduction source is also refused', () => {
    const target = { outletId: 'theupcoming', url: null };
    const r = mergeUniqueReviewFields(target, { wrongProduction: true, url: 'https://x.test/2022-review' });
    assert.strictEqual(r.action, 'skip-flagged-source');
    assert.strictEqual(target.url, null);
  });

  test('unflagged source merges only missing fields', () => {
    const target = { outletId: 'telegraph', url: null, excerpt: 'kept' };
    const source = { outletId: 'telegraph', url: 'https://telegraph.co.uk/r', excerpt: 'ignored', publishDate: '2026-07-01' };
    const r = mergeUniqueReviewFields(target, source);
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.changed, true);
    assert.strictEqual(target.url, 'https://telegraph.co.uk/r');
    assert.strictEqual(target.excerpt, 'kept');
    assert.strictEqual(target.publishDate, '2026-07-01');
  });

  test('exclusion/pointer fields never transfer even when both sides are flagged', () => {
    const target = { outletId: 'x', wrongProduction: true };
    const source = { outletId: 'x', wrongProduction: true, duplicateOf: 'other--file.json', rejectionReason: 'not_a_review', excerpt: 'text' };
    const r = mergeUniqueReviewFields(target, source);
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(target.duplicateOf, undefined);
    assert.strictEqual(target.rejectionReason, undefined);
    assert.strictEqual(target.excerpt, 'text');
  });

  test('duplicateOf source counts as flagged (pointer must not migrate)', () => {
    const target = { outletId: 'x' };
    const r = mergeUniqueReviewFields(target, { duplicateOf: 'sibling.json', url: 'https://x.test/r' });
    assert.strictEqual(r.action, 'skip-flagged-source');
  });

  test('no-change merge reports changed=false', () => {
    const target = { outletId: 'x', url: 'https://x.test/r' };
    const r = mergeUniqueReviewFields(target, { outletId: 'x', url: 'https://x.test/other' });
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.changed, false);
  });

  test('isExclusionFlagged covers the rejection classes', () => {
    assert.strictEqual(isExclusionFlagged({ rejectionReason: 'not_a_review' }), true);
    assert.strictEqual(isExclusionFlagged({ wrongProduction: true }), true);
    assert.strictEqual(isExclusionFlagged({ wrongProduction: false }), false);
    assert.strictEqual(isExclusionFlagged({ isRoundupArticle: true }), true);
    assert.strictEqual(isExclusionFlagged({ suspectedMisattribution: true }), true);
    assert.strictEqual(isExclusionFlagged({}), false);
  });
});

describe('rebuild wiring', () => {
  test('rebuild-all-reviews.js consolidation passes use the guarded merge', () => {
    const contents = readFileSync(resolve(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
    assert.match(contents, /require\(['"]\.\/lib\/merge-review-fields['"]\)/,
      'rebuild-all-reviews.js must import mergeUniqueReviewFields');
    const calls = contents.match(/mergeUniqueReviewFields\s*\(/g) || [];
    assert.ok(calls.length >= 2,
      `both cleanup passes (--unknown rename, outlet-prefix mismatch) must use the guarded merge; found ${calls.length}`);
    assert.ok(!/for \(const \[key, val\] of Object\.entries\(d\)\)/.test(contents),
      'a consolidation pass still blind-copies fields — route it through mergeUniqueReviewFields');
  });
});
