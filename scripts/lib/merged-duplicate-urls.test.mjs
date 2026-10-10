/**
 * BRO-4414: URLs folded into a survivor by a merge must never be re-adopted.
 * Culture Sauce "How Shakespeare Saved My Life" (2026-09-30): the merge deleted
 * culturesauce--unknown.json, then Playbill Verdict handed its URL back to the
 * survivor via mergeReviews and applyUrlChangeInvariant wiped text + score.
 * Requires the real functions (CLAUDE.md §15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { mergeUniqueReviewFields } = require(resolve(ROOT, 'scripts/lib/merge-review-fields.js'));
const { mergeReviews, maybeUpgradeUrl } = require(resolve(ROOT, 'scripts/lib/review-normalization.js'));
const { isMergedDuplicateUrl, recordMergedDuplicateUrl, absorbMergedDuplicates } = require(resolve(ROOT, 'scripts/lib/merged-duplicate-urls.js'));
const { createOrMergeReviewFile } = require(resolve(ROOT, 'scripts/lib/review-file-writer.js'));

const LONG = 'https://culturesauce.com/how-shakespeare-saved-my-life-treats-the-bard-as-life-coach-off-broadway-review/';
const SHORT = 'https://culturesauce.com/how-shakespeare-saved-my-life-off-broadway-review/';
const survivor = () => ({
  showId: 'how-shakespeare-saved-my-life-off-broadway-2026', outletId: 'culturesauce', criticName: 'Thom Geier',
  url: LONG, fullText: 'x'.repeat(3800), contentTier: 'complete', assignedScore: 58, scoreSource: 'anchored-v6',
  originalScore: '3/5 stars',
});
const loser = () => ({ outletId: 'culturesauce', criticName: 'Unknown', url: SHORT, source: 'broad-web-serp' });

describe('merged-away url tombstone', () => {
  test('mergeUniqueReviewFields records the loser url on the survivor', () => {
    const t = survivor();
    const r = mergeUniqueReviewFields(t, loser());
    assert.equal(r.action, 'merged');
    assert.equal(r.changed, true);
    assert.deepEqual(t.mergedDuplicateUrls, [SHORT]);
    assert.equal(t.url, LONG);
  });

  test('recording is idempotent, ignores own url and garbage', () => {
    const t = survivor();
    assert.equal(recordMergedDuplicateUrl(t, LONG), false);
    assert.equal(recordMergedDuplicateUrl(t, 'N/A'), false);
    assert.equal(recordMergedDuplicateUrl(t, SHORT), true);
    assert.equal(recordMergedDuplicateUrl(t, SHORT.slice(0, -1)), false);
    assert.equal(t.mergedDuplicateUrls.length, 1);
  });

  test('mergeReviews refuses to adopt a merged-away url and keeps text + score', () => {
    const t = survivor();
    recordMergedDuplicateUrl(t, SHORT);
    const out = mergeReviews(t, { outletId: 'culturesauce', criticName: 'Thom Geier', url: SHORT, source: 'playbill-verdict' });
    assert.equal(out.url, LONG);
    assert.equal(out.assignedScore, 58);
    assert.equal(out.fullText.length, 3800);
  });

  test('control: without the tombstone the same write does wipe the survivor (the bug)', () => {
    const out = mergeReviews(survivor(), { outletId: 'culturesauce', criticName: 'Thom Geier', url: SHORT, source: 'playbill-verdict' });
    assert.equal(out.url, SHORT);
    assert.equal(out.fullText, undefined);
  });

  test('maybeUpgradeUrl refuses a merged-away url even on bad content', () => {
    const t = { ...survivor(), fullText: null, contentTier: 'stub', assignedScore: undefined, originalScore: undefined };
    recordMergedDuplicateUrl(t, SHORT);
    assert.equal(maybeUpgradeUrl(t, SHORT, 'playbill-verdict'), false);
    assert.equal(t.url, LONG);
  });

  test('createOrMergeReviewFile does not re-create the deleted duplicate file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro4414-'));
    const showId = 'vanya-off-broadway-2025';
    const showDir = join(dir, showId);
    require('node:fs').mkdirSync(showDir);
    const NYT_LONG = 'https://www.nytimes.com/2025/09/01/theater/vanya-review-long.html';
    const NYT_SHORT = 'https://www.nytimes.com/2025/09/01/theater/vanya-review.html';
    const t = { ...survivor(), showId, outletId: 'nytimes', criticName: 'Jesse Green', url: NYT_LONG };
    recordMergedDuplicateUrl(t, NYT_SHORT);
    writeFileSync(join(showDir, 'nytimes--jesse-green.json'), JSON.stringify(t));
    const r = createOrMergeReviewFile(showId, {
      outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Unknown', url: NYT_SHORT, source: 'broad-web-serp',
      fields: { fullText: null, contentTier: 'excerpt' },
    }, { reviewTextsDir: dir });
    assert.equal(r.action, 'skipped');
    assert.match(r.reason, /merged-duplicate-url/);
    assert.deepEqual(readdirSync(showDir), ['nytimes--jesse-green.json']);
  });

  test('isMergedDuplicateUrl is false for unrelated urls and records without the field', () => {
    assert.equal(isMergedDuplicateUrl(survivor(), SHORT), false);
    const t = survivor(); recordMergedDuplicateUrl(t, SHORT);
    assert.equal(isMergedDuplicateUrl(t, 'https://culturesauce.com/other-review/'), false);
  });
});

describe('chain merges and escape hatch', () => {
  test('A<-B<-C: folding a survivor that has tombstones keeps them all', () => {
    const b = survivor(); recordMergedDuplicateUrl(b, SHORT);
    const a = { ...survivor(), url: 'https://culturesauce.com/a/' };
    assert.equal(mergeUniqueReviewFields(a, b).changed, true);
    assert.equal(isMergedDuplicateUrl(a, SHORT), true);
    assert.equal(isMergedDuplicateUrl(a, LONG), true);
    const c = { url: 'https://culturesauce.com/c/', mergedDuplicateUrls: ['https://culturesauce.com/d/'] };
    const target = { url: 'https://culturesauce.com/t/', mergedDuplicateUrls: [SHORT] };
    absorbMergedDuplicates(target, c);
    assert.equal(target.mergedDuplicateUrls.length, 3);
  });

  test('urlManualOverride on the incoming write bypasses the merged-duplicate refusal', () => {
    const t = survivor(); recordMergedDuplicateUrl(t, SHORT);
    const out = mergeReviews(t, { outletId: 'culturesauce', criticName: 'Thom Geier', url: SHORT, urlManualOverride: true });
    assert.equal(out.url, SHORT);
  });
});

describe('drift: every fold-and-delete site records the merged-away url', () => {
  const { readFileSync } = require('node:fs');
  for (const f of [
    'scripts/lib/merge-review-fields.js',
    'scripts/consolidate-duplicate-reviews.js',
    'scripts/fix-critic-name-duplicates.js',
    'scripts/backfill-pv-critics.js',
    'scripts/fix-outlet-case.js',
  ]) {
    test(`${f} records merged duplicate urls`, () => {
      assert.match(readFileSync(resolve(ROOT, f), 'utf8'), /(record|absorb)MergedDuplicateUrls?|absorbMergedDuplicates/);
    });
  }
});
