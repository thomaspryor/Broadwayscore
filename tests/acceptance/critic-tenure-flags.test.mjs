/**
 * Acceptance for critic/outlet tenure flags (BRO-5222 / BRO-5232).
 * Runs the real corpus scan over data/review-texts (private; skipped where the
 * corpus is not checked out, e.g. the land gate). Ratchet: unresolved flags
 * (neither fixed in the data nor listed with evidence in
 * scripts/config/critic-tenure-reviewed.json) may not exceed maxUnresolved in
 * that file. BRO-5232 is done when maxUnresolved is 0 and this passes.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scanReviewTexts, DEFAULT_REVIEW_TEXTS_DIR } = require('../../scripts/lib/critic-review-scan.js');
const { findTenureFlags, applyReviewedTenureFlags, tenureFlagKey } = require('../../scripts/lib/critic-tenure.js');
const { reviewed, maxUnresolved } = require('../../scripts/config/critic-tenure-reviewed.json');

const corpusPresent = fs.existsSync(DEFAULT_REVIEW_TEXTS_DIR) && fs.readdirSync(DEFAULT_REVIEW_TEXTS_DIR).length > 100;

test('critic/outlet tenure flags stay within the reviewed ratchet', { skip: corpusPresent ? false : 'data/review-texts corpus not present' }, () => {
  assert.ok(Number.isInteger(maxUnresolved) && maxUnresolved >= 0, 'maxUnresolved must be a non-negative integer');
  const { critics, totalFiles } = scanReviewTexts();
  assert.ok(totalFiles > 1000, `review-texts corpus too small (${totalFiles} files)`);
  const r = applyReviewedTenureFlags(findTenureFlags(critics), reviewed);
  assert.deepStrictEqual(r.invalid, [], 'reviewed entries need a key and an http(s) evidence link');
  assert.deepStrictEqual(r.stale.map(e => e.key), [], 'reviewed entries that no longer match a flag');
  assert.ok(
    r.unresolved.length <= maxUnresolved,
    `${r.unresolved.length} unresolved tenure flags > maxUnresolved ${maxUnresolved}:\n` +
      r.unresolved.map(f => `[${f.kind}] ${f.critic} at ${f.outlet}: ${tenureFlagKey(f)}`).join('\n'),
  );
});
