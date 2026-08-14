/**
 * Acceptance test for the two follow-ups from the 2026-08-13 null-openingDate
 * blackout, written so the nightly acceptance-recheck can actually re-run them.
 *
 * Both assertions read the LIVE repo, not fixtures — the point is to fail if
 * the fix is ever reverted or was never really made, which is the whole reason
 * these cards exist. A fixture-based version would pass forever and prove
 * nothing.
 *
 * Cards:
 *   "P0: the new uncollected-review guard is not wired into ANY workflow —
 *    it only runs if a human types it"
 *   "P1: 2 more coverage audits share the null-openingDate blindness just
 *    fixed in audit-show-review-gap"
 *
 * Renamed from `_skip-coverage-guard-wired.test.mjs` and registered in
 * tests/unit-test-manifest.txt (task #1091, 2026-08-14) — the `_skip-` prefix
 * is scripts/audit-orphan-tests.js's INTENTIONAL-opt-out convention, so this
 * file never actually ran in CI despite its own docstring's intent. It was a
 * second live instance of exactly the "guard exists but nothing invokes it"
 * class the two cards above were written to catch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the uncollected-review guard is referenced by at least one workflow', () => {
  // A detector nothing schedules is a script nobody calls. On 2026-08-13 the
  // guard shipped with zero callers, so the next blackout would have been
  // found the same way the last one was: by the owner noticing a blank page.
  const wfDir = join(ROOT, '.github', 'workflows');
  assert.ok(existsSync(wfDir), '.github/workflows must exist');

  const callers = readdirSync(wfDir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .filter(f => readFileSync(join(wfDir, f), 'utf8').includes('audit-uncollected-live-reviews'));

  assert.ok(
    callers.length > 0,
    'no workflow invokes scripts/audit-uncollected-live-reviews.js — the coverage guard only runs when a human types it'
  );
});

test('coverage audits do not drop live shows on a null openingDate', () => {
  // The defect: `if (!show.openingDate) return false` silently removes every
  // show still in previews from the audit population, and a check that never
  // runs never fails. audit-show-review-gap.js was fixed on 2026-08-13; these
  // two carried the identical predicate.
  const audits = [
    'scripts/audit-opening-night-coverage.js',
    'scripts/audit-standing-coverage.js',
    'scripts/audit-show-review-gap.js', // already fixed — guards against regression
  ];

  for (const rel of audits) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue; // renamed/removed is a different problem
    const src = readFileSync(path, 'utf8');

    // Strip comments so the explanatory prose describing the OLD bug (which
    // legitimately quotes the predicate) doesn't read as the bug itself.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n');

    const bareGuard = /!\s*(?:show|s|prod|other)\s*\.\s*openingDate\s*\)\s*(?:return\s+false|return\s+null|continue)/;
    assert.ok(
      !bareGuard.test(code),
      `${rel} still excludes shows on a bare null openingDate — use showRecencyKey() from scripts/lib/collection-priority.js so previewsStartDate is honoured`
    );
  }
});
