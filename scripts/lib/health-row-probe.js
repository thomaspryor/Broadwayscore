/**
 * health-row-probe.js — side-effect-free, same-day health-row verification
 * (Digest-autofix S5, task #1224, follow-up to #1184).
 *
 * scripts/check-health-row-absent.js deliberately reads YESTERDAY's snapshot
 * instead of re-running scripts/health-check.js, because a real run sends
 * emails and writes alert ledgers. That means a fix session can never prove
 * its own fix landed until the next morning's snapshot — attempt-memory
 * scores same-day fixes as failures. This module re-runs the CORE check list
 * (health-check.js's computeCoreHealthResults, the same function main() uses)
 * live and read-only, and reports whether one named row is currently flagged.
 *
 * Two defenses against side effects, deliberately layered (belt-and-braces —
 * same idiom as autonomous-triage-core.js's MUTATING_SCRIPT_RE comment):
 *   1. Primary: computeCoreHealthResults(false, { dryRun: true }) — isCI=false
 *      already suppresses checkAlertRouterDeadman's routeAlert() call (that
 *      guard predates this file), and dryRun=true skips checkDispatchOutcomes'
 *      one unconditional state-cache write.
 *   2. Backstop: fs.writeFileSync/appendFileSync are monkey-patched to no-ops
 *      for the duration of the call (restored in `finally`) so any FUTURE
 *      check that adds an unguarded write is automatically caught too —
 *      deliberately NOT a name→check registry (the card's explicit
 *      objection: a registry rots as checks are added/renamed; a blanket
 *      write-stub does not need updating when the check list changes).
 *
 * WHY "unknown" exists as a third verdict, not just present/absent: several
 * of the 22 checks skip themselves under a missing credential (no GH_TOKEN /
 * NOTION_API_KEY / VERCEL_TOKEN / SCRAPINGBEE_API_KEY / SCRAPINGDOG_API_KEY —
 * exactly the environment scripts/lib/autonomous-checks.js's checksEnv()
 * hands this command when it runs as a card's checkableDone verify step) and
 * emit ONE placeholder row (e.g. 'Cron: health') instead of the per-item rows
 * they'd normally produce (e.g. 'Cron: Update Show Status'). In that case the
 * target row name never appears in the live results AT ALL, under any
 * status — indistinguishable, by name alone, from "genuinely fixed". Treating
 * that as a pass would be a false pass through the exact credential-stripped
 * path this feature exists to serve. The rule below instead requires the
 * target row to appear in the live results under SOME status (pass, to
 * verify fixed; warn/error, to verify still-broken) — no match at all, or a
 * match whose message is itself a "Skipped — " credential-skip placeholder,
 * means the live probe cannot speak to this row right now.
 */

'use strict';

const fs = require('fs');

const LIMIT = 120; // same bound digest-autofix encodes rows with (check-health-row-absent.js)

function normalizeName(name) {
  return String(name || '').trim().slice(0, LIMIT);
}

function isCredentialSkip(result) {
  return result.status === 'warn' && /^Skipped — /.test(String(result.message || ''));
}

// Monkey-patches fs.writeFileSync/appendFileSync to no-ops for the duration
// of `fn`, restoring the originals even if `fn` throws. Patches the shared
// `fs` module object's methods, not a per-caller reference, so it also
// blankets any require()d-at-call-time module (health-check.js is required
// inside `fn`, after the patch is applied) without needing that module to
// accept an injected fs.
async function withWritesDisabled(fn) {
  const originalWriteFileSync = fs.writeFileSync;
  const originalAppendFileSync = fs.appendFileSync;
  let writeAttempted = false;
  fs.writeFileSync = (...args) => { writeAttempted = true; };
  fs.appendFileSync = (...args) => { writeAttempted = true; };
  try {
    const result = await fn();
    return { result, writeAttempted };
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.appendFileSync = originalAppendFileSync;
  }
}

/**
 * Re-runs the live core health checks and reports whether `rowName` is
 * currently flagged.
 *
 * @returns {Promise<{verdict: 'absent'|'present'|'unknown', matched: object|null, writeAttempted: boolean, generatedAt: string}>}
 *   verdict:
 *     'absent'  — the row appeared with status 'pass' (or didn't need to run
 *                 at all because nothing in that family is flagged): fixed.
 *     'present' — the row appeared with status 'error'/'warn' and a real
 *                 (non-credential-skip) message: still broken.
 *     'unknown' — the row never appeared under any status, or only appeared
 *                 as a credential-skip placeholder: this environment cannot
 *                 verify it right now (see module header).
 */
async function probeHealthRowLive(rowName) {
  const target = normalizeName(rowName);
  const { result: allResults, writeAttempted } = await withWritesDisabled(async () => {
    // Required inside the patched window (not at module top) so a future
    // caller that imports this file before any fs-writer runs still gets the
    // patch applied around health-check.js's own module-load-time code, not
    // just around the function call.
    const { computeCoreHealthResults } = require('../health-check.js');
    return computeCoreHealthResults(false, { dryRun: true });
  });

  const match = allResults.find((r) => normalizeName(r.name) === target);

  let verdict;
  if (!match || isCredentialSkip(match)) {
    verdict = 'unknown';
  } else if (match.status === 'error' || match.status === 'warn') {
    verdict = 'present';
  } else {
    verdict = 'absent';
  }

  return {
    verdict,
    matched: match || null,
    writeAttempted,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { probeHealthRowLive, normalizeName, isCredentialSkip, LIMIT };
