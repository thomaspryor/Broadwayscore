/**
 * Regression test for the 3-way PROTECTED_FIELDS sync between:
 *   1. scripts/lib/review-write-guard.js  PROTECTED_FIELDS  (canonical)
 *   2. .github/actions/push-review-texts/action.yml  inline PROTECTED array
 *   3. scripts/lib/restore-protected-fields.js  MANUAL_FIELDS  (narrower subset)
 *
 * Bug history (2026-04-24): #2 listed `incompleteReason` + `incompleteDetail`
 * as protected, but #1 explicitly EXCLUDED them with a comment that they are
 * derived fields and must not be preserved across pushes. The drift caused
 * rebuild's classifyIncompleteReason clearings to be silently reverted, blocking
 * ~500 valid reviews from reviews.json. See Notion 34c637c5-416f-8199.
 *
 * This test enforces that #2 never re-introduces fields that #1 explicitly
 * excludes via the canonical EXPLICITLY_EXCLUDED list below.
 *
 * Per CLAUDE.md §15: require() the real source of truth; never duplicate the lists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..');

const { PROTECTED_FIELDS } = require(path.join(repoRoot, 'scripts/lib/review-write-guard.js'));

// Fields that review-write-guard.js explicitly excludes from PROTECTED_FIELDS
// because they are DERIVED (rebuild re-classifies them every run). If any of
// these appear in another list, that list will silently restore stale values
// after rebuild's clearing logic.
const EXPLICITLY_EXCLUDED_FROM_PROTECTED = [
  'incompleteReason',
  'incompleteDetail',
];

// Compute the effective PROTECTED list used by .github/actions/push-review-texts/action.yml.
// S2-T2 (2026-04-26): action.yml now imports PROTECTED_FIELDS from review-write-guard.js
// at runtime and unions them with a small ACTION_EXTRA list. The test mirrors that
// composition by reading the same source files.
function loadActionPushProtected() {
  const yamlPath = path.join(repoRoot, '.github/actions/push-review-texts/action.yml');
  const text = fs.readFileSync(yamlPath, 'utf8');

  // The action must require PROTECTED_FIELDS from review-write-guard.js.
  if (!/\bPROTECTED_FIELDS\b[^}]*\}\s*=\s*require\(/.test(text)) {
    throw new Error(
      'action.yml must require { PROTECTED_FIELDS } from scripts/lib/review-write-guard.js (S2-T2 unification)'
    );
  }

  // Pull the action-specific extension list.
  const extraMatch = text.match(/const\s+ACTION_EXTRA\s*=\s*\[([\s\S]*?)\];/);
  const extra = extraMatch
    ? Array.from(extraMatch[1].replace(/\/\/[^\n]*\n/g, '\n').matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)).map(m => m[1])
    : [];

  return Array.from(new Set([...PROTECTED_FIELDS, ...extra]));
}

test('action.yml PROTECTED never re-introduces fields explicitly excluded by review-write-guard', () => {
  const actionFields = loadActionPushProtected();
  const accidental = EXPLICITLY_EXCLUDED_FROM_PROTECTED.filter(f => actionFields.includes(f));
  assert.deepEqual(
    accidental, [],
    `push-review-texts/action.yml PROTECTED must not include derived fields ` +
    `${EXPLICITLY_EXCLUDED_FROM_PROTECTED.join(', ')} — these are excluded from review-write-guard.js ` +
    `PROTECTED_FIELDS by design (see line 127 there). Re-introducing them re-creates the ` +
    `2026-04-24 incompleteReason regression.\nFound: ${accidental.join(', ')}`
  );
});

test('action.yml PROTECTED list is non-empty and parseable', () => {
  const actionFields = loadActionPushProtected();
  assert.ok(actionFields.length >= 30,
    `expected ≥30 fields in action.yml PROTECTED, got ${actionFields.length}. ` +
    `Parser may be broken or list may have been emptied.`);
  // Sanity check: a few fields that MUST be protected
  for (const required of ['fullText', 'assignedScore', 'llmScore', 'humanReviewScore', 'wrongProduction']) {
    assert.ok(actionFields.includes(required),
      `action.yml PROTECTED must include "${required}" — missing risks data loss on push.`);
  }
});

test('review-write-guard PROTECTED_FIELDS does NOT include the explicitly-excluded derived fields', () => {
  for (const excluded of EXPLICITLY_EXCLUDED_FROM_PROTECTED) {
    assert.ok(!PROTECTED_FIELDS.includes(excluded),
      `review-write-guard.js PROTECTED_FIELDS must NOT include "${excluded}" — ` +
      `it is a derived field that classifyIncompleteReason re-computes every rebuild.`);
  }
});
