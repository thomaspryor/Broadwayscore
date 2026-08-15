/**
 * Exemption list for scripts/lib/ledger-coverage-check.js.
 *
 * Task #996 shipped a real AST-based transitive call-graph check (acorn),
 * not the "grep direct importers of url-discovery.js" the original card
 * 3b1637c5 audit used — and the AST walk found 40 job-level gaps beyond the
 * 18 workflows already fixed in 436f4a24092/943bd4a9327 (plus the 2
 * already-known remaining gaps that card explicitly deferred:
 * update-precursor-awards.yml, fix-platform-ticket-links.yml).
 *
 * BRO-163 (2026-08-15) closed all 39 real gaps from that list — 9 turned
 * out to be detector false negatives (jobs already staged the ledger via a
 * bare `git add data/audit/` directory add, which the checker's substring
 * search for the literal filename missed; fixed in ledger-coverage-check.js's
 * lineStagesLedgerViaDirectAdd) and the remaining 30 got a real
 * "Commit scraper-spend ledger" step via the new reusable composite action
 * at .github/actions/commit-scraper-spend-ledger/ (extracted from the
 * inline pattern in audit-closing-dates.yml once ~50 call sites needed it —
 * the checker recognizes a job that `uses:` this action as staging the
 * ledger even though the actual `git add` line lives inside the action
 * file, not the calling workflow; see COMMIT_LEDGER_ACTION_RE).
 *
 * ONE entry remains, and it is NOT a real gap — it's a documented detector
 * false positive, kept here (rather than fixed in the checker) because
 * generalizing SCRIPT_INVOKE_RE to distinguish "text inside a JS template
 * literal building a GitHub issue body" from "an actual `node scripts/X.js`
 * shell invocation" is a materially bigger, riskier change to a check every
 * push depends on, for a single known instance. See its `reason` field for
 * specifics. This file stays non-empty (and thus un-deleted) until either
 * that detector limitation is fixed, or the disabled issue-creation code in
 * update-show-status.yml:create-issue is removed outright.
 *
 * Do not add new entries to silence a genuinely-fixable violation — every
 * entry here must be either a real currently-existing gap with a dated
 * reason, or (like the one below) an explained detector false positive.
 */

const EXEMPTIONS = [
  {
    file: 'update-show-status.yml',
    job: 'create-issue',
    reason:
      "2026-08-15 (BRO-163): detector false positive, not a real gap. The checker's " +
      'SCRIPT_INVOKE_RE matches "node scripts/gather-reviews.js" as plain text inside a ' +
      'JS template literal building a GitHub issue body (actions/github-script step) — that ' +
      'code path is unreachable (issue creation is explicitly disabled: "Skipping issue ' +
      'creation — pipeline handles these automatically"), and even if it ran, it would never ' +
      'execute the shell command, only print it as markdown in an issue.',
  },
];

function isExempt(file, job) {
  return EXEMPTIONS.some((e) => e.file === file && e.job === job);
}

module.exports = { EXEMPTIONS, isExempt };
