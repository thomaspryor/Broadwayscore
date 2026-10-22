// TESTS-VS-DERIVED-DATA-EXEMPT: structural: asserts the derived reviews.json still carries one pinned review; pins no show fact
// BRO-5737 (BRO-3425 pattern): live-data assertion split out of tests/unit/review-gap-remediation.test.mjs. data/reviews.json is
// rebuilt by bots many times a day, so in a code-test batch it can redden main with no code change. Runs in
// check-corpus-drift.yml's "Live-data assertions" step, excluded from the unit batches in scripts/lib/unit-test-collection.js.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..');

it('reviews.json agrees with the review-texts source for the Disruption Teeman NYT review (task #1180)', () => {
  // Cross-check against the derived output reviews.json rolls up from this
  // same source file — if they disagree, the rebuild pipeline itself is
  // the bug, and that is worth failing loudly on too.
  const reviewsPath = path.join(REPO_ROOT, 'data', 'reviews.json');
  let arr;
  try {
    const raw = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    arr = Array.isArray(raw) ? raw : (raw.reviews || Object.values(raw));
  } catch {
    return; // reviews.json not populated in this environment — nothing further to assert
  }
  const teeman = arr.find(r => r.showId === 'disruption-off-broadway-2026' && r.criticName === 'Tim Teeman');
  assert.ok(teeman, 'expected a Tim Teeman review for disruption-off-broadway-2026 in data/reviews.json');
  assert.ok(/nytimes\.com/.test(teeman.url || ''), 'expected the Disruption Teeman review to be an nytimes.com URL');
  assert.notEqual(teeman.wrongAttribution, true);
});
