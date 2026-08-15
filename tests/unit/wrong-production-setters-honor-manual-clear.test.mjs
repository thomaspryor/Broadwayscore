/**
 * Guard-presence regression: every script that writes wrongProduction=true MUST
 * also check shouldSkipWrongProductionAudit() (or an equivalent manual-clear
 * predicate) so it doesn't re-flag files that a human/sweep has cleared.
 *
 * Background (Notion 34e637c5-416f-811d, Session 5 stale wrongProduction audit):
 * The first cut of that session cleared 175 stale flags on disk via
 * scripts/clear-stale-wrong-production-flags.js, writing wrongProductionManualClear=true
 * as a durable breadcrumb. /ship-check immediately found 6 setter scripts that
 * checked only `if (data.wrongProduction) skip` — once cleared, they re-fired on
 * the next CI run (audit-cross-show-url-collisions runs every collect-review-texts
 * cycle, ~24h re-flag latency). All 6 patched in commit 1916416cf1.
 *
 * Without this test, a future change that removes the guard from any setter
 * silently undoes the manual-clear work. The pattern is invisible at PR review
 * unless the reviewer remembers the asymmetry.
 *
 * Test approach: grep-based, intentionally simple. For each known setter,
 * assert the file imports and calls shouldSkipWrongProductionAudit. Mirroring
 * tests/unit/protected-fields-three-way-sync.test.mjs's pattern of checking
 * file content for required wiring.
 *
 * If a NEW setter is added, this test won't catch it — that's a separate
 * problem (no static way to discover all setters). The wrongProductionManualClear
 * breadcrumb being in restore-protected-fields MANUAL_FIELDS is a second
 * defensive layer (survives rebase even if a setter does fire).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');

// Setters that auto-flag based on heuristics or audits — MUST honor manual-clear.
// Original 6 from /ship-check on 2026-04-26 (commit 1916416cf1).
// 6 more added when this test was authored after grepping the broader corpus.
// If a new wrongProduction setter is added to scripts/, add it here.
const KNOWN_SETTERS = [
  // Original 6 (commit 1916416cf1):
  'audit-cross-show-url-collisions.js',
  'audit-touring-contamination.js',
  'flag-we-cross-production.js',
  'flag-wrong-production-by-url-date.js',
  'cleanup-known-issues.js',
  'audit-pre2005-reviews.js',
  // Added when discovery test surfaced these gaps:
  'adjudicate-review-queue.js',         // daily LLM adjudication, line 354
  'audit-wrong-production.js',          // weekly audit --fix mode, line 559
  'cleanup-dedup-comprehensive.js',     // cleanup pipeline, line 282
  'cleanup-review-sources.js',          // BWW tour-review tagger, line 245/261
  'collect-review-texts.js',            // anticipatory_pre_opening_post gate, line 4280
  'gather-reviews.js',                  // existingData re-flag at line 3149
  // Cross-production auto-flaggers (added 2026-06-21): each honors manual-clear via
  // shouldSkipWrongProductionAudit before writing wrongProduction=true.
  'apply-cross-production-llm-flags.js', // conservative apply of Opus WRONG verdicts
  'auto-triage-cross-production.js',     // conservative flagging from cross-prod audit
  'fetch-guardian-reviews.js',           // guardian-api stale-slug flag
  // Incident repair for the 2026-08-06 noteless auto-clear bug (#1108). Restores
  // flags the buggy mergeReviews predicate wrongly cleared — so it writes
  // wrongProduction=true and owes the same guard: a file a human explicitly
  // cleared or overrode is left alone. (added 2026-08-07, #1085)
  'repair-noteless-wrongprod-autoclear.js',
  // Backfill audit for same-title sibling misroutes (task #1617). Skips
  // shouldSkipWrongProductionAudit()-cleared files before ever computing a
  // hit, in addition to its own humanReviewedWrongProduction/manualClear/
  // override/explicit-false checks. (added 2026-08-15, #1617)
  'audit-sibling-title-misroute.js',
];

describe('wrongProduction setter scripts honor manual-clear breadcrumb', () => {
  for (const setter of KNOWN_SETTERS) {
    test(`${setter} imports + calls shouldSkipWrongProductionAudit`, () => {
      const filePath = path.join(SCRIPTS_DIR, setter);
      assert.ok(fs.existsSync(filePath), `${setter} not found at ${filePath}`);
      const src = fs.readFileSync(filePath, 'utf8');

      // The guard may be shouldSkipWrongProductionAudit OR the stronger
      // shouldSkipCrossShowUrlFlag — the latter calls the former internally and
      // adds a CV check (review-guards.js), so it honors the manual-clear
      // breadcrumb too. A setter that calls either is protected.
      const GUARD = /(shouldSkipWrongProductionAudit|shouldSkipCrossShowUrlFlag)/;

      // Must import a guard helper (any of these forms count).
      const hasImport =
        GUARD.test(src) &&
        /require\(['"]\.\/lib\/review-guards['"]\)/.test(src);
      assert.ok(
        hasImport,
        `${setter} must require shouldSkipWrongProductionAudit (or shouldSkipCrossShowUrlFlag) ` +
        `from ./lib/review-guards. Without this guard, every cleared wrongProductionManualClear ` +
        `file gets re-flagged on the next CI run. See Notion 34e637c5-416f-811d / commit 1916416cf1.`
      );

      // Must actually CALL a guard helper (not just import).
      const callCount = (src.match(/(shouldSkipWrongProductionAudit|shouldSkipCrossShowUrlFlag)\s*\(/g) || []).length;
      assert.ok(
        callCount >= 1,
        `${setter} imports a wrongProduction guard but never calls it. ` +
        `Add shouldSkipWrongProductionAudit() or shouldSkipCrossShowUrlFlag() before each ` +
        `\`data.wrongProduction = true\` write.`
      );
    });
  }

  test('no NEW setter outside the known list — alert if grep finds one', () => {
    // Grep-find ALL scripts that write wrongProduction=true. If we find one
    // outside KNOWN_SETTERS, the test list is stale and the new setter likely
    // lacks the guard. This is advisory — bumps the maintainer to add it to
    // KNOWN_SETTERS or document an exemption.
    const ALLOWED_NON_GUARDED = new Set([
      // rebuild-all-reviews.js has 13 setters, all already guarded by
      // shouldSkipWrongProductionAudit at the surrounding condition (verified
      // 2026-04-26). It's a giant orchestration file — exempt because the
      // grep would always hit and the guard pattern is per-block, not per-line.
      'rebuild-all-reviews.js',
      // Sweep scripts are intentional flag-clearers + flag-restorers, not auditors.
      'clear-stale-wrong-production-flags.js',
      'restore-protected-fields.js',
      // Manual-flag-by-id utilities (called by humans, not CI auditors).
      // The whole point is to override the breadcrumb when the human is wrong.
      'flag-wrong-production-by-id.js',
      'flag-wrong-production-by-date.js',
      'flag-wrong-production-pending.js',
      'fix-timeout-we-attribution.js',           // explicit URL-substring-driven manual fix
      'fix-wrong-reviews.js',                    // CLI 'flagWrongProd' command, by-file
      // verify-existing-reviews / quarantine — operate on explicit user-supplied
      // file lists, not auto-audits.
      'verify-existing-reviews.js',
      'quarantine-wrong-production-reviews.js',
      'fix-wrong-production-reviews.js',
      'unflag-wrong-production-fps.js',
      'gc-wrong-production-stubs.js',
      'classify-wrong-production.js',
      // extract-bww-reviews.js — extracts FRESH reviews from HTML, outputs JSON
      // to stdout. Doesn't touch existing on-disk files; no manual-clear breadcrumb
      // to honor. (Verified: only writes via console.log JSON.stringify on line 248.)
      'extract-bww-reviews.js',
      // fix-aggregator-gap-override-contamination.js — by design OVERRIDES poison
      // wrongProductionOverride/manualClear breadcrumbs that automated ingest stamped
      // onto cross-production-contaminated files (it sets a durable wrongProductionReason
      // rather than fighting the per-file protected-fields restore). Honoring the
      // manual-clear breadcrumb here would defeat its purpose, so it's exempt — same
      // category as the other intentional override/by-id utilities above. (2026-06-21)
      'fix-aggregator-gap-override-contamination.js',
      // audit-show-review-gap.js's recoverEmptyBodyFlaggedMiss (Tender/Sessions
      // guard, commit 31b41dbd81a) sets wrongProduction=true ONLY immediately
      // after ITS OWN fresh recovery fetch lands text dated outside the
      // production window — it never re-scans pre-existing on-disk files
      // looking for something to flag. The manual-clear protection this test
      // enforces is already provided by a DIFFERENT gate: flagged-recovery.js's
      // isRecoverableFlaggedFile() excludes wrongProduction===true AND
      // wrongProductionManualClear===true files from ever being selected for
      // this code path again (lines 53-54), so a human-cleared false positive
      // can never be re-fetched and re-flagged by this setter. Functionally
      // equivalent to shouldSkipWrongProductionAudit, via the selection gate
      // instead of an in-function check. (ship-check 2026-07-24, #371)
      'audit-show-review-gap.js',
      // repair-noteless-wrongprod-autoclear.js — one-off manual CLI (dry-run
      // default, --apply to write) that restores flags wrongly auto-cleared by
      // the 2026-08-06 noteless-default bug in mergeReviews. Its own predicate
      // (fixedClearIsLegitimate) checks pre.wrongProductionManualClear before
      // ever restoring, so it never re-flags a file a human explicitly cleared
      // — the exact protection shouldSkipWrongProductionAudit provides, just
      // evaluated against a reconstructed pre-incident git blob instead of the
      // live file. Not CI-scheduled; not in any workflow. (task #1086)
      'repair-noteless-wrongprod-autoclear.js',
    ]);

    const allFiles = fs.readdirSync(SCRIPTS_DIR)
      .filter(f => f.endsWith('.js'));
    const setters = [];
    for (const f of allFiles) {
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
      // Match `data.wrongProduction = true` or `d.wrongProduction = true` etc.
      // Excludes assignments to false/null and comparisons.
      if (/\b\w+\.wrongProduction\s*=\s*true\b/.test(src)) {
        setters.push(f);
      }
    }
    const unknown = setters.filter(s =>
      !KNOWN_SETTERS.includes(s) && !ALLOWED_NON_GUARDED.has(s)
    );
    assert.deepStrictEqual(
      unknown,
      [],
      `New wrongProduction setter(s) detected outside the known list: ${unknown.join(', ')}. ` +
      `Either add to KNOWN_SETTERS (and ensure it has shouldSkipWrongProductionAudit guard) ` +
      `or to ALLOWED_NON_GUARDED with a comment explaining why.`
    );
  });
});
