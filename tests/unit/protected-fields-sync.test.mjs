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
  'allowTourSignalReason',
  'allowFilmSignal',
  'routedFromShowId',
  'wrongProductionManualClear',
  'wrongArticleManualClear',
  'wrongShowManualClear',
  'wrongProductionOverride',
  // wrongProductionOverrideReason/SetAt/SetBy + wrongShowOverrideReason/At: the
  // boolean survives without these, but the audit trail (who/why/when) is
  // silently dropped on rebase — found while migrating card #644's 6 scripts
  // onto clearWrongProductionFlags, which multiplied the callers writing these
  // fields from 1 (flag-combined-reviews.js) to 6.
  'wrongProductionOverrideReason',
  'wrongProductionOverrideSetAt',
  'wrongProductionOverrideSetBy',
  'wrongShowOverride',
  'wrongShowOverrideReason',
  'wrongShowOverrideAt',
  'humanReviewedWrongProduction',
  'humanReviewedWrongArticle',
  // Added in Rocky Horror 2026-04-23 postmortem (Session 2 #7)
  'humanReviewedTour',
  'humanReviewScoreProvisional',
  'humanReviewScoreClearedForLlm',
  'isTourReview',
  'isLikelyTourReview',
  'dtliThumb',
  'bwwThumb',
];

test('review-write-guard.js PROTECTED_FIELDS contains every opening-night override', () => {
  const missing = REQUIRED_OVERRIDES.filter(f => !PROTECTED_FIELDS.includes(f));
  assert.deepEqual(missing, [],
    `PROTECTED_FIELDS missing overrides — will silently drop on rebase`);
});

test('push-review-texts/action.yml effective PROTECTED list contains every opening-night override', () => {
  // S2-T2 (2026-04-26): action.yml no longer inlines the PROTECTED array — it
  // imports PROTECTED_FIELDS from scripts/lib/review-write-guard.js at runtime
  // and unions with a small ACTION_EXTRA list. We mirror that composition.
  const actionYml = readRepo('.github/actions/push-review-texts/action.yml');
  assert.ok(
    /\bPROTECTED_FIELDS\b[^}]*\}\s*=\s*require\(/.test(actionYml),
    'action.yml must require { PROTECTED_FIELDS } from scripts/lib/review-write-guard.js (S2-T2)'
  );
  const extraMatch = actionYml.match(/const\s+ACTION_EXTRA\s*=\s*\[([\s\S]*?)\];/);
  const extra = extraMatch
    ? Array.from(extraMatch[1].replace(/\/\/[^\n]*\n/g, '\n').matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)).map(m => m[1])
    : [];
  const effective = new Set([...PROTECTED_FIELDS, ...extra]);
  const missing = REQUIRED_OVERRIDES.filter(f => !effective.has(f));
  assert.deepEqual(missing, [],
    `push-review-texts/action.yml effective PROTECTED list missing overrides — CI push will drop them`);
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
