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
 * of the 22 checks skip themselves — under a missing credential (no GH_TOKEN /
 * NOTION_API_KEY / VERCEL_TOKEN / SCRAPINGBEE_API_KEY / SCRAPINGDOG_API_KEY —
 * exactly the environment scripts/lib/autonomous-checks.js's checksEnv()
 * hands this command when it runs as a card's checkableDone verify step), or
 * because required local data isn't checked out in this worktree/sandbox
 * (private review-texts, core data, an outlet registry) — and emit ONE
 * placeholder row (e.g. 'Cron: health', status 'warn') or a benign-looking
 * PASS placeholder (e.g. checkSync's "Sync: review-texts vs reviews.json"
 * at status 'pass' when review-texts isn't checked out) instead of the
 * per-item rows they'd normally produce (e.g. 'Cron: Update Show Status').
 * Ship-check adversarial review (task #1224, two independent reviewers)
 * caught the pass-status case: matching only `status:'warn'` skip rows let a
 * card targeting one of the pass-status skip forms exit 0 in a sandbox that
 * never actually re-ran the real check — a false pass through the exact
 * credential/checkout-stripped path this feature exists to serve. Every
 * self-skip message in health-check.js (grepped, not guessed) starts with
 * the literal word "Skipped" regardless of status — isSkipPlaceholder()
 * below matches on that prefix alone, independent of status, so the rule
 * generalizes to future self-skips without a status/message registry.
 * The rule below instead requires the target row to appear in the live
 * results under SOME non-skip status (pass, to verify fixed; warn/error, to
 * verify still-broken) — no match at all, or a match that's itself a skip
 * placeholder, means the live probe cannot speak to this row right now.
 */

'use strict';

const fs = require('fs');

const LIMIT = 120; // same bound digest-autofix encodes rows with (check-health-row-absent.js)

function normalizeName(name) {
  return String(name || '').trim().slice(0, LIMIT);
}

// See the module-header note above (ship-check finding, task #1224): every
// self-skip in health-check.js — credential-gated ("Skipped — no GH_TOKEN"),
// checkout-gated ("Skipped (review-texts not checked out)"), or CI-gated
// ("Skipped in CI (...)") — starts with the word "Skipped", regardless of
// which status it's stamped with. Matching status:'warn' only (the original,
// narrower version of this function) missed every checkout-gated pass-status
// form and produced false passes for them.
function isSkipPlaceholder(result) {
  return /^Skipped\b/.test(String(result.message || ''));
}

// Monkey-patches fs.writeFileSync/appendFileSync/unlinkSync/renameSync (sync
// and fs.promises) to no-ops for the duration of `fn`, restoring the
// originals even if `fn` throws. Patches the shared `fs` module object's
// methods, not a per-caller reference, so it also blankets any
// require()d-at-call-time module (health-check.js is required inside `fn`,
// after the patch is applied) without needing that module to accept an
// injected fs. Reentrant: a reference count means a call nested inside
// another (or two concurrent in-process calls, e.g. via Promise.all) share
// one patched window and only the outermost caller restores the real
// methods — ship-check adversarial finding (task #1224): the original
// non-reentrant version let the second of two overlapping calls restore real
// writers while the first was still mid-flight, or vice versa, silently
// un-protecting one of them.
let disableDepth = 0;
let originals = null;
let blockedWriteCount = 0;
function withWritesDisabled(fn) {
  if (disableDepth === 0) {
    blockedWriteCount = 0;
    originals = {
      writeFileSync: fs.writeFileSync,
      appendFileSync: fs.appendFileSync,
      unlinkSync: fs.unlinkSync,
      renameSync: fs.renameSync,
      promisesWriteFile: fs.promises.writeFile,
      promisesAppendFile: fs.promises.appendFile,
      promisesUnlink: fs.promises.unlink,
      promisesRename: fs.promises.rename,
    };
    const noop = () => { blockedWriteCount++; };
    const noopAsync = async () => { blockedWriteCount++; };
    fs.writeFileSync = noop;
    fs.appendFileSync = noop;
    fs.unlinkSync = noop;
    fs.renameSync = noop;
    fs.promises.writeFile = noopAsync;
    fs.promises.appendFile = noopAsync;
    fs.promises.unlink = noopAsync;
    fs.promises.rename = noopAsync;
  }
  disableDepth++;
  return (async () => {
    try {
      const result = await fn();
      return { result, writeAttempted: blockedWriteCount > 0 };
    } finally {
      disableDepth--;
      if (disableDepth === 0) {
        Object.assign(fs, {
          writeFileSync: originals.writeFileSync,
          appendFileSync: originals.appendFileSync,
          unlinkSync: originals.unlinkSync,
          renameSync: originals.renameSync,
        });
        Object.assign(fs.promises, {
          writeFile: originals.promisesWriteFile,
          appendFile: originals.promisesAppendFile,
          unlink: originals.promisesUnlink,
          rename: originals.promisesRename,
        });
        originals = null;
      }
    }
  })();
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
  if (!match || isSkipPlaceholder(match)) {
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

module.exports = { probeHealthRowLive, normalizeName, isSkipPlaceholder, LIMIT };
