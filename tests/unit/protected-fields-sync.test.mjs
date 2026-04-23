import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { PROTECTED_FIELDS } = require('../../scripts/lib/review-write-guard.js');
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// The three locations that must stay in sync for opening-night manual-ingest
// overrides to survive CI rebases. Drift here is the postmortem issue #6
// failure mode — a field set by ingest-manual-review.js gets dropped during
// the next CI push + rebase cycle.
const REQUIRED_OVERRIDES = [
  'allowEarlyDate',
  'allowLateDate',
  'allowCrossMarket',
  'allowTourSignal',
  'allowFilmSignal',
  'routedFromShowId',
  'wrongProductionManualClear',
  'wrongArticleManualClear',
  'wrongShowManualClear',
  'wrongProductionOverride',
  'humanReviewedWrongProduction',
  'humanReviewedWrongArticle',
];

test('review-write-guard.js PROTECTED_FIELDS contains every opening-night override', () => {
  const missing = REQUIRED_OVERRIDES.filter(f => !PROTECTED_FIELDS.includes(f));
  assert.deepEqual(missing, [],
    `PROTECTED_FIELDS missing overrides — will silently drop on rebase`);
});

test('push-review-texts/action.yml PROTECTED array contains every opening-night override', () => {
  const actionYml = readRepo('.github/actions/push-review-texts/action.yml');
  const missing = REQUIRED_OVERRIDES.filter(f => !new RegExp(`'${f}'`).test(actionYml));
  assert.deepEqual(missing, [],
    `push-review-texts/action.yml PROTECTED array missing overrides — CI push will drop them`);
});

test('restore-protected-fields.js MANUAL_FIELDS contains every opening-night override', () => {
  const src = readRepo('scripts/lib/restore-protected-fields.js');
  const missing = REQUIRED_OVERRIDES.filter(f => !new RegExp(`'${f}'`).test(src));
  assert.deepEqual(missing, [],
    `restore-protected-fields.js MANUAL_FIELDS missing overrides — rebase-restore loop won't rescue them`);
});

test('per-file protectedFields array itself is in PROTECTED_FIELDS', () => {
  assert.ok(PROTECTED_FIELDS.includes('protectedFields'),
    'protectedFields array must self-protect or per-file locks get cleared');
});
