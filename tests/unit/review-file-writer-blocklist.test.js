/**
 * BRO-3410: createOrMergeReviewFile (the shared writer chokepoint) honors the
 * per-show _blocklist.json, so no caller can re-create an operator-deleted review.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');

const SHOW = 'safe-house-off-broadway-2026';
const BLOCKED = 'https://www.example-outlet.com/reviews/safe-house';

function corpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3410-'));
  fs.mkdirSync(path.join(root, SHOW), { recursive: true });
  fs.writeFileSync(path.join(root, SHOW, '_blocklist.json'),
    JSON.stringify({ urls: [{ url: BLOCKED, reason: 'wrong production' }] }));
  return root;
}

test('blocklisted URL is skipped and nothing is written', () => {
  const root = corpus();
  const r = createOrMergeReviewFile(SHOW, { outlet: 'Variety', url: BLOCKED + '?utm_source=x', source: 'test', fields: { fullText: 'x'.repeat(2000) } }, { reviewTextsDir: root });
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'blocklisted-url');
  assert.deepEqual(fs.readdirSync(path.join(root, SHOW)), ['_blocklist.json']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a different URL is not refused by the blocklist guard', () => {
  const root = corpus();
  const r = createOrMergeReviewFile(SHOW, { outlet: 'Variety', url: 'https://variety.com/2026/legit', source: 'test', fields: {} }, { reviewTextsDir: root, dryRun: true });
  assert.notEqual(r.reason, 'blocklisted-url');
  fs.rmSync(root, { recursive: true, force: true });
});
