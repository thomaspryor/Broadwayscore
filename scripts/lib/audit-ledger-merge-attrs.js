'use strict';
/**
 * Lint gate (BRO-2493): every tracked data/audit/*.jsonl ledger must either
 * be declared `merge=union` in .gitattributes, or appear in the
 * EXEMPT_LEDGERS list below with a dated, checked reason.
 *
 * WHY THIS EXISTS: sync-audit-checkout.sh's union-recovery stage (BRO-2314)
 * only unblocks a launchd job's `git merge --ff-only` for a path that is
 * tracked, `*.jsonl`, AND declared merge=union — a ledger missing that
 * attribute re-creates the exact six-day gate outage BRO-2314 closed for
 * stage-latency.jsonl/scraper-spend-ledger.jsonl the moment it goes dirty
 * locally while CI moves it on origin/main. 17 of the repo's 20 tracked
 * data/audit/*.jsonl files were in exactly that state (2026-08-26 audit).
 *
 * merge=union is a real git 3-way-merge driver: on conflict it keeps BOTH
 * sides' lines, verbatim, UNORDERED (the recovery path appends locally-saved
 * rows after origin's rows regardless of real timestamps — see
 * scripts/lib/sync-audit-decision.js's unionLedgerLines()). Two things
 * disqualify a ledger from union:
 *   (a) a reader that SUMS or otherwise aggregates duplicate keys, or a
 *       consumed/resolved row that must never come back — silently
 *       corrupted by a resurrected stale line;
 *   (b) a reader that assumes array/file order encodes true chronological
 *       order (first-element-is-earliest, walk-newest-to-oldest, a
 *       consecutive-streak count) without first re-sorting by an explicit
 *       timestamp field.
 * A writer that merely prunes old rows chronologically (a ring buffer) is
 * NOT disqualifying on its own — scraper-spend-ledger.jsonl already
 * establishes that precedent in .gitattributes: a union-resurrected pruned
 * row is stale data, never a wrong computed value, and self-heals on the
 * next real write.
 *
 * Pure (string/array in, data out) per CLAUDE.md rule 15 — the git reads
 * (`git ls-files`, `git check-attr`) live in the colocated test's
 * "REGRESSION: every real tracked ledger..." case
 * (scripts/lib/audit-ledger-merge-attrs.test.mjs), same pattern
 * scripts/lib/core-data-registry-coverage.js already uses.
 */

// Each entry names the checked, disqualifying reason a file's own writer
// (and, where relevant, reader) makes merge=union unsafe — not a guess, a
// verified read of the actual code as of the date given. Re-verify the
// reason still holds before removing an entry (i.e. before declaring the
// file merge=union) rather than assuming it's stale.
const EXEMPT_LEDGERS = [
  {
    file: 'data/audit/arm-yield-ledger.jsonl',
    reason:
      '2026-08-26 (BRO-2493): record-arm-yield.js dedupes by (arm, date) keeping ' +
      'only the LAST write for a re-recorded day, and separately prunes every row ' +
      'older than its retention cutoff — both are real, intentional deletions, not ' +
      'a pure chronological ring-buffer trim. check-arm-yield.js\'s indexLedger() ' +
      'SUMS itemsFound across every row sharing an (arm, date) key instead of ' +
      'taking the latest one, so a union merge that resurrects a stale/superseded ' +
      'day would silently inflate that day\'s summed count and skew arm-health ' +
      'judging — a wrong computed value, not just a harmless duplicate line.',
  },
  {
    file: 'data/audit/ensemble-sole-outlier-queue.jsonl',
    reason:
      '2026-08-26 (BRO-2493): dead file — one commit ever (a2ba1902283, the ' +
      'one-time 2,608-row seed), no script writes it today (gemini-calibration-' +
      'ema.js only reads it for --seed). No active writer means no real ' +
      'concurrent-append race to protect against; union would be a no-op driver ' +
      'for a file nothing appends to. Revisit if a writer is ever added.',
  },
  {
    file: 'data/audit/multiauthor-attribution-candidates.jsonl',
    reason:
      '2026-08-26 (BRO-2493): audit-multiauthor-attributions.js computes `suspects` ' +
      'fresh from a from-scratch scan every run and fs.writeFileSync()s the whole ' +
      'file — it never reads its own prior output. This is the "COMPLETE fresh ' +
      'snapshot (latest-wins)" shape .gitattributes already documents for the ' +
      'merge=ours JSON audit-state files above, not an append-only ledger; a ' +
      'union merge would permanently accumulate every past run\'s candidates ' +
      'alongside the current run\'s, resurrecting resolved/stale ones forever.',
  },
  {
    file: 'data/audit/provider-spend-daily.jsonl',
    reason:
      '2026-08-26 (BRO-2493): check-provider-spend.js\'s writer removes any ' +
      'existing row for today\'s day before appending the fresh one ' +
      '(`ledger.filter(r => r.day !== DAY)`) — a same-day REPLACE, not a pure ' +
      'append. A union merge could leave two rows for the same day (an old, ' +
      'superseded one plus the new one) with no dedupe rule of its own to ' +
      'resolve them, unlike owner-email-log.jsonl above which has a dedicated ' +
      'post-merge reconcile function for exactly that case.',
  },
  {
    file: 'data/audit/recent-pushes.jsonl',
    reason:
      '2026-08-26 (BRO-2493): dead on main since 2c2e9cd7eee (2026-08-02, "move ' +
      'push-ledger off main") — the live ledger now lives on the single-commit ' +
      '`push-ledger` branch via scripts/lib/push-ledger-store.js\'s compare-and-' +
      'swap, specifically to get OFF main\'s commit-churn/merge-conflict surface. ' +
      'No writer touches this tracked copy anymore (git log: last content commit ' +
      'predates the migration); adding a driver to a frozen file protects nothing.',
  },
  {
    file: 'data/audit/star-scale-mismatch-candidates.jsonl',
    reason:
      '2026-08-26 (BRO-2493): audit-outlet-star-scales.js computes `suspects` ' +
      'fresh from a from-scratch review-texts scan every run and ' +
      'fs.writeFileSync()s the whole file — same "COMPLETE fresh snapshot" shape ' +
      'as multiauthor-attribution-candidates.jsonl above, not an append-only ' +
      'ledger. A union merge would permanently accumulate stale candidates from ' +
      'every past run instead of reflecting only the latest scan.',
  },
  {
    file: 'data/audit/score-history.jsonl',
    reason:
      '2026-08-26 (BRO-2493, Codex ship-check review): concurrent runs can each ' +
      'independently observe a missing (date, showId) row and append DIFFERENT ' +
      'values for it (score-history-snapshot.js only dedupes against what it ' +
      'already read, not a shared lock) — a union merge could leave two rows for ' +
      'the same key. unexplained-score-jump.check.js\'s readLastTwoSnapshots() ' +
      'keeps the FIRST entry per date in file order ' +
      '(`if (!byDate.has(e.date)) byDate.set(e.date, e)`), so which of the two ' +
      'the score-jump alarm uses as that day\'s baseline is arbitrary post-merge, ' +
      'not necessarily the correct one — a wrong computed value feeding a real ' +
      'alert, not a harmless duplicate line.',
  },
  {
    file: 'data/audit/census-recall-trend.jsonl',
    reason:
      '2026-08-26 (BRO-2493, Codex ship-check review): audit-serp-census-recall.js\'s ' +
      'appendTrendEntry() deliberately REPLACES a same-date row (keeping the ' +
      'stronger measurement) specifically so the regression detector\'s median ' +
      'does not "double-weight" a date — its own doc comment says so. That ' +
      'reconciliation is a dedicated JS merge function (mergeCensusRecallTrend) ' +
      'that only runs on push-with-retry.sh\'s separate CI reconcile pass; ' +
      'sync-audit-checkout.sh\'s local recovery stage instead does byte-for-byte ' +
      'line union (unionLedgerLines()), which has no notion of "same date, ' +
      'stronger measurement wins" and would leave two same-date rows — exactly ' +
      'the double-weighting the writer exists to prevent.',
  },
  {
    file: 'data/audit/coverage-adversarial-probe-trend.jsonl',
    reason:
      '2026-08-26 (BRO-2493, Codex ship-check review): same shape as ' +
      'census-recall-trend.jsonl above — coverage-adversarial-probe.js\'s ' +
      'appendTrendEntry() replaces a same-date row unless the new one measured ' +
      'fewer shows, again to avoid double-weighting a date in whatever reads the ' +
      'trend series. The dedicated merge function ' +
      '(mergeCoverageAdversarialProbeTrend) only runs on the CI reconcile path, ' +
      'not sync-audit-checkout.sh\'s local recovery, which would union two ' +
      'same-date rows verbatim.',
  },
  {
    file: 'data/audit/autonomous-recheck-ledger.jsonl',
    reason:
      '2026-08-26 (BRO-2493): autonomous-acceptance-recheck.js\'s enforcementState() ' +
      'reads `rechecks[0].ts` as the FIRST (oldest) recheck to compute the shadow-' +
      'period\'s elapsed days, trusting file order as chronological order — but ' +
      'sync-audit-checkout.sh\'s recovery appends locally-saved rows after ' +
      'origin\'s rows regardless of real timestamps, so rechecks[0] is no longer ' +
      'reliably the oldest after a union recovery. That elapsed-days figure, plus ' +
      'a bare rechecks.length count with no dedup key, feeds shouldExitShadow() ' +
      '(scripts/lib/autonomous-recheck-core.js), which arms automatic card-' +
      'reopening — too consequential a gate to risk on merge-disturbed order.',
  },
  {
    file: 'data/audit/digest-autofix-ledger.jsonl',
    reason:
      '2026-08-26 (BRO-2493): scripts/lib/attempt-memory.js\'s checkPark() walks ' +
      'the ledger newest-to-oldest counting a CONSECUTIVE streak of same-hash ' +
      '\'fail\' rows and parks the card once the streak hits maxFailures (default ' +
      '2) — both the walk direction and the "consecutive" test assume file order ' +
      'is true chronological order. sync-audit-checkout.sh\'s recovery appends ' +
      'locally-saved rows after origin\'s rows regardless of real timestamps, so a ' +
      'union recovery can reorder or interleave rows and either falsely park a ' +
      'card that failed once, or mask a real 2-in-a-row failure — with a bar this ' +
      'low (2), order corruption is not a marginal risk.',
  },
];

const EXEMPT_LEDGER_PATHS = new Set(EXEMPT_LEDGERS.map((e) => e.file));

function isExemptLedgerPath(file) {
  return EXEMPT_LEDGER_PATHS.has(file);
}

/**
 * @param {string[]} files repo-relative tracked data/audit/*.jsonl paths
 * @param {(file: string) => string|null|undefined} mergeAttrOf returns the
 *   file's git `merge` attribute value (e.g. 'union', 'unspecified', null)
 * @returns {{file: string}[]} files that are neither declared merge=union
 *   nor listed in EXEMPT_LEDGERS — the real gap this gate exists to catch.
 */
function findLedgersMissingUnionOrExemption(files, mergeAttrOf) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  if (typeof mergeAttrOf !== 'function') throw new TypeError('mergeAttrOf must be a function');
  return files
    .filter((f) => mergeAttrOf(f) !== 'union' && !isExemptLedgerPath(f))
    .map((file) => ({ file }));
}

/**
 * A file listed in EXEMPT_LEDGERS for a reasoned, checked disqualifier must
 * never ALSO carry merge=union in .gitattributes — that would silently
 * override the exemption (git only sees the attribute; it has no idea an
 * exemption reason exists) and reintroduce the exact corruption the entry
 * documents. Codex ship-check finding (2026-08-26): the coverage check above
 * alone can't catch this, since a file declared union is already "covered"
 * before its exemption status is even consulted.
 *
 * @param {(file: string) => string|null|undefined} mergeAttrOf
 * @returns {{file: string}[]} EXEMPT_LEDGERS entries that are ALSO merge=union
 */
function findExemptLedgersWronglyUnioned(mergeAttrOf) {
  if (typeof mergeAttrOf !== 'function') throw new TypeError('mergeAttrOf must be a function');
  return EXEMPT_LEDGERS.filter((e) => mergeAttrOf(e.file) === 'union').map((e) => ({ file: e.file }));
}

module.exports = {
  EXEMPT_LEDGERS,
  isExemptLedgerPath,
  findLedgersMissingUnionOrExemption,
  findExemptLedgersWronglyUnioned,
};
