import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanApplyScriptsForVerifyGap } from './apply-scripts-verify-pushed-scan.js';

test('flags a script with --apply + safeWriteReview and no verify helper (the BRO-3862 shape)', () => {
  const files = [{
    path: 'scripts/audit-review-type-wrong-show.js',
    content: `
      const args = { apply: argv.includes('--apply') };
      const { safeWriteReview } = require('./lib/review-write-guard');
      safeWriteReview(filePath, data);
    `,
  }];
  const result = scanApplyScriptsForVerifyGap(files);
  assert.equal(result.scanned, 1);
  assert.deepEqual(result.flagged, [{ path: 'scripts/audit-review-type-wrong-show.js' }]);
});

test('does not flag once the script requires verify-review-texts-pushed', () => {
  const files = [{
    path: 'scripts/audit-review-type-wrong-show.js',
    content: `
      const args = { apply: argv.includes('--apply') };
      const { safeWriteReview } = require('./lib/review-write-guard');
      const { verifyReviewTextsPushed } = require('./lib/verify-review-texts-pushed');
      safeWriteReview(filePath, data);
    `,
  }];
  const result = scanApplyScriptsForVerifyGap(files);
  assert.deepEqual(result.flagged, []);
});

test('does not flag a script with --apply but no safeWriteReview (nothing to verify)', () => {
  const files = [{
    path: 'scripts/apply-image-cleanup.js',
    content: `const args = { apply: argv.includes('--apply') }; fs.unlinkSync(imagePath);`,
  }];
  const result = scanApplyScriptsForVerifyGap(files);
  assert.deepEqual(result.flagged, []);
});

test('does not flag a script with safeWriteReview but no --apply flag (always-on writer)', () => {
  const files = [{
    path: 'scripts/gather-reviews.js',
    content: `const { safeWriteReview } = require('./lib/review-write-guard'); safeWriteReview(f, d);`,
  }];
  const result = scanApplyScriptsForVerifyGap(files);
  assert.deepEqual(result.flagged, []);
});

test('scans multiple files and only flags the gap', () => {
  const files = [
    { path: 'a.js', content: `'--apply'; safeWriteReview(x, y);` },
    { path: 'b.js', content: `'--apply'; safeWriteReview(x, y); require('./lib/verify-review-texts-pushed');` },
    { path: 'c.js', content: `console.log('nothing relevant here');` },
  ];
  const result = scanApplyScriptsForVerifyGap(files);
  assert.equal(result.scanned, 3);
  assert.deepEqual(result.flagged, [{ path: 'a.js' }]);
});
