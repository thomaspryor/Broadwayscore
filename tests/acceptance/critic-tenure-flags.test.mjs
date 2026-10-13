/**
 * Acceptance for critic/outlet tenure flags (BRO-5222 / BRO-5232).
 * Runs the real corpus scan (needs data/review-texts). Passes when every
 * tenure flag is either fixed in the data or listed, with evidence, in
 * scripts/config/critic-tenure-reviewed.json. Not part of the unit manifest:
 * it reads the private review-texts corpus.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scanReviewTexts } = require('../../scripts/lib/critic-review-scan.js');
const { findTenureFlags, applyReviewedTenureFlags, tenureFlagKey } = require('../../scripts/lib/critic-tenure.js');
const { reviewed } = require('../../scripts/config/critic-tenure-reviewed.json');

test('every critic/outlet tenure flag is fixed or reviewed with evidence', () => {
  const { critics, totalFiles } = scanReviewTexts();
  assert.ok(totalFiles > 1000, `review-texts corpus not available (${totalFiles} files)`);
  const r = applyReviewedTenureFlags(findTenureFlags(critics), reviewed);
  assert.deepStrictEqual(r.invalid, [], 'reviewed entries need a key and an http(s) evidence link');
  assert.deepStrictEqual(r.stale.map(e => e.key), [], 'reviewed entries that no longer match a flag');
  assert.deepStrictEqual(
    r.unresolved.map(f => `[${f.kind}] ${f.critic} at ${f.outlet}: ${tenureFlagKey(f)}`),
    [],
    `${r.unresolved.length} unresolved tenure flags`,
  );
});
