'use strict';
/**
 * Lint gate (BRO-2493, widened repo-wide by BRO-2497): every tracked *.jsonl
 * file ANYWHERE in the repo must either be declared `merge=union` in
 * .gitattributes, or appear in the EXEMPT_LEDGERS list below with a dated,
 * checked reason. A union-declared *.jsonl OUTSIDE data/audit/ must also be
 * covered by a VERIFIED_UNION_LEDGERS entry naming its checked-safe reader
 * (data/audit/'s union set was reviewed file by file in BRO-2493 and is
 * documented inline in .gitattributes). That carve-out holds only for a
 * data/audit file .gitattributes names by its exact path: one covered only by
 * a glob rule (data/audit/fact-check/*.jsonl) was never reviewed, so it needs
 * a VERIFIED_UNION_LEDGERS entry like any other (BRO-5261 retro-review).
 *
 * WHY REPO-WIDE (BRO-2497): the original gate only listed `data/audit`, but
 * the union-recovery stage in sync-audit-checkout.sh reads
 * `git status --porcelain --untracked-files=all` with no path filter and
 * scripts/lib/sync-audit-decision.js's unionLedgerCandidates() accepts ANY
 * tracked path that is `*.jsonl` AND merge=union. The mechanism is keyed on
 * the extension plus the attribute, not the directory, so the gate is too.
 *
 * WHY *.jsonl AND NOT EVERY merge=union FILE: unionLedgerCandidates()
 * deliberately refuses non-.jsonl paths even when they are merge=union (its
 * doc comment names tests/unit-test-manifest.txt, the only such tracked file
 * today, as the reason). A non-.jsonl union file therefore can never enter
 * the recovery path this gate protects; its driver only matters to ordinary
 * `git merge`, and the manifest's own .gitattributes comment documents that
 * its reader treats it as a set. Widening to it would gate a file the
 * mechanism cannot touch.
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
 * (`git ls-files '*.jsonl'`, `git check-attr`) live in the colocated test's
 * "REGRESSION: every real tracked *.jsonl..." case
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
    file: 'data/audit/claude-session-cost.jsonl',
    reason:
      '2026-10-29 (BRO-5671): claude-session-cost-writer.js upserts by (date, session), ' +
      'replacing a re-recorded session\'s row in place. A union merge would resurrect the ' +
      'superseded row beside the replacement, double-counting that session\'s cost.',
  },
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
    file: 'data/audit/scraper-spend-daily-agg.jsonl',
    reason:
      '2026-09-13 (BRO-3202, consolidated with a since-removed duplicate ' +
      'BRO-3092 entry — BRO-3868 what-else sweep found the same file listed ' +
      'twice, added independently by two same-day sessions): identical writer ' +
      'and identical semantics to provider-spend-daily.jsonl directly above — ' +
      'the same script, check-provider-spend.js, removes every existing row ' +
      'for today before writing the fresh ones (`existingAgg.filter((r) => ' +
      'r.day !== DAY)` at check-provider-spend.js:175, the exact shape of the ' +
      '`ledger.filter((r) => r.day !== DAY)` at :161 that earned its sibling ' +
      'this exemption) and then fs.writeFileSync()s the whole file at :189. ' +
      'That is a same-day REPLACE, not an append, so a union merge could leave ' +
      'a superseded day\'s rows beside the fresh ones with no dedupe rule to ' +
      'resolve them — and these rows are SUMMED into a 7-day attribution ' +
      'window, so resurrected rows would inflate spend attribution rather than ' +
      'just duplicate a line. core-data-merge-registry.js:288 independently ' +
      'records it as single-writer in the data-health-check concurrency group ' +
      '(written only by CI under one concurrency group, so it is never dirty ' +
      'locally), so there is no concurrent-append race for a driver to protect ' +
      'against in the first place. Verified no other reader sums it: grep for ' +
      'the path across scripts/, src/, .github/ finds only its own writer, ' +
      'this exemption, core-data-merge-registry.js:288, and a test-name string.',
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
    file: 'data/linear-import-mapping.jsonl',
    reason:
      '2026-10-13 (BRO-2497): scripts/lib/import-ledger.js documents its READ ' +
      'SEMANTICS as "last row wins per pageId" — indexByPageId() and ' +
      'indexByIdentifier() walk the file in order and Map.set() each row, so a ' +
      'correction is a LATER row superseding an earlier one. That is criterion ' +
      '(b): a union recovery appends locally-saved rows after origin\'s, so a ' +
      'stale pre-correction row could land after its correction and silently ' +
      'win, pointing the anti-join / rollback at the wrong Linear issue. The ' +
      'Notion->Linear migration it served is finished (Notion retired ' +
      '2026-08-20), so there is no live concurrent writer to protect either.',
  },
  {
    file: 'data/archive/notion-card-history.jsonl',
    reason:
      '2026-10-13 (BRO-2497): export-notion-outcome-history.js rebuilds the ' +
      'WHOLE file from the frozen Notion corpus, sorted by pageId, and ' +
      'fs.writeFileSync()s it (tmp + rename) — a "COMPLETE fresh snapshot" like ' +
      'multiauthor-attribution-candidates.jsonl, not an append-only ledger. A ' +
      'union merge would keep superseded copies of re-exported rows beside the ' +
      'new ones. Notion is retired (2026-08-20), so nothing re-exports it on a ' +
      'schedule; its only other reader is lint-committed-pii.js (a PII scan, ' +
      'order-insensitive).',
  },
  {
    file: 'data/seat-research-eval/history.jsonl',
    reason:
      '2026-10-13 (BRO-2497): written only by a hand-run dev tool ' +
      '(eval-seat-research.js appendFileSync; no workflow invokes it), so CI ' +
      'never moves it on origin and there is no concurrent-append race to ' +
      'protect. Its reader is also order-sensitive (criterion b): ' +
      'compareVersions() takes `runs[runs.length - 1]` as the LATEST run per ' +
      'promptVersion in file order, so a union-reordered file would compare the ' +
      'wrong runs.',
  },
  {
    file: 'tests/fixtures/lint-committed-pii/clean.jsonl',
    reason:
      '2026-10-13 (BRO-2497): static test fixture read by ' +
      'tests/unit/lint-committed-pii.test.mjs (scanFile). No writer appends to ' +
      'it, so there is no race to protect; a union driver would only let a ' +
      'merge silently combine two edits of an expected-output fixture.',
  },
  {
    file: 'tests/fixtures/lint-committed-pii/dirty-attempts.jsonl',
    reason:
      '2026-10-13 (BRO-2497): static test fixture for lint-committed-pii.js, ' +
      'same as clean.jsonl beside it — hand-edited, never appended to by any ' +
      'script, so merge=union protects nothing and could mask a conflicting ' +
      'fixture edit.',
  },
];

// BRO-5951 cross-model audit caches: single-writer one-off audit outputs. readRows()
// in scripts/audit-review-crossmodel.js keeps the LAST row per key and the reverify
// subcommand rewrites whole files, so a union merge could resurrect superseded rows.
{
  const reason = '2026-10-22 (BRO-5951): audit-review-crossmodel.js readRows() is last-row-wins per key and reverify rewrites the file in place, so union could resurrect superseded rows; one writer, no concurrent-append race.';
  const cohorts = ['bw-historical', 'ob-historical', 'we-2017-2018', 'we-2018-2019', 'we-2019-2020', 'we-2020-2021', 'we-2021-2022', 'we-2022-2023', 'we-2023-2024', 'we-2024-2025', 'we-2025-2026'];
  for (const check of ['completeness', 'pages', 'score']) {
    for (const c of cohorts) if (!(check !== 'completeness' && c === 'we-2017-2018')) EXEMPT_LEDGERS.push({ file: `data/audit/crossmodel/${check}-${c}.jsonl`, reason });
  }
  EXEMPT_LEDGERS.push({ file: 'data/audit/crossmodel/spend.jsonl', reason });
}

const EXEMPT_LEDGER_PATHS = new Set(EXEMPT_LEDGERS.map((e) => e.file));

function isExemptLedgerPath(file) {
  return EXEMPT_LEDGER_PATHS.has(file);
}

/**
 * @param {string[]} files repo-relative tracked *.jsonl paths (repo-wide)
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

// merge=union *.jsonl outside data/audit/ whose readers were checked against
// criteria (a) and (b) above. `pattern` is a repo-relative glob where `*`
// matches within one path segment only.
const VERIFIED_UNION_LEDGERS = [
  {
    pattern: 'data/opening-night-timeline/*.jsonl',
    reason:
      '2026-10-13 (BRO-2497): one append-only snapshot log per show, written by ' +
      'scripts/generate-status-page.js (appendFileSync, CI rebuild-reviews.yml ' +
      'commits them). Readers checked by grepping "opening-night-timeline" ' +
      'across scripts/, src/, .github/: only generate-status-page.js reads the ' +
      'rows (show-id-keyed-files.js and rebuild-reviews.yml only name the path; ' +
      'show-id-rename.js rewrites each line in place, order-preserving). ' +
      'Criterion (a): nothing sums or aggregates by key; rows are plotted as a ' +
      'sparkline. Criterion (b): BOTH reads trusted file order (dedupe against ' +
      'the last line; sparkline + date label from [0]/[length-1]) — fixed in ' +
      'this card by routing both through scripts/lib/opening-night-timeline.js ' +
      'parseTimelineJsonl(), which re-sorts by the explicit `t` timestamp and ' +
      'collapses exact-duplicate lines. Worst case after that is one redundant ' +
      'snapshot row, a cosmetic sparkline point on a noindex status page.',
  },
  {
    pattern: 'data/audit/fact-check/*.jsonl',
    reason:
      '2026-10-14 (BRO-5261 retro-review of BRO-2497): declared union by the ' +
      '.gitattributes glob (BRO-5080), so never reviewed per file. Readers ' +
      'checked by grepping "fact-check/", "-checks.jsonl" and "bro-5089" across ' +
      'scripts/, src/, .github/: the <cohort>-checks.jsonl files are read only by ' +
      'scripts/fact-check-historical-sample.js readChecks() (also reached via ' +
      'plan-we-historical-opening-repair.js triage()); the bro-5089-*.jsonl ' +
      'files have no code reader. Criterion (b): readChecks kept the LAST row per ' +
      'id, so a union-reordered older check could win; fixed here to keep the ' +
      'row with the newest checkedAt. Criterion (a): nothing sums by key.',
  },
];

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

const VERIFIED_UNION_MATCHERS = VERIFIED_UNION_LEDGERS.map((e) => ({ ...e, re: globToRegExp(e.pattern) }));

function isVerifiedUnionPath(file) {
  return VERIFIED_UNION_MATCHERS.some((m) => m.re.test(file));
}

/**
 * BRO-2497: a merge=union *.jsonl (outside data/audit/, or inside it but
 * covered only by a glob rule) with no VERIFIED_UNION_LEDGERS entry — union declared, but nobody checked whether
 * its readers survive unordered/duplicated rows.
 *
 * @param {string[]} files repo-relative tracked *.jsonl paths
 * @param {(file: string) => string|null|undefined} mergeAttrOf
 * @returns {{file: string}[]}
 */
function findUnverifiedUnionLedgers(files, mergeAttrOf, perFileDeclared = new Set()) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  if (typeof mergeAttrOf !== 'function') throw new TypeError('mergeAttrOf must be a function');
  return files
    .filter((f) => !(f.startsWith('data/audit/') && perFileDeclared.has(f)) && mergeAttrOf(f) === 'union' && !isVerifiedUnionPath(f))
    .map((file) => ({ file }));
}

/**
 * Paths .gitattributes declares merge=union by EXACT path (no glob): the
 * per-file BRO-2493 review set.
 * @param {string} gitattributesText
 * @returns {Set<string>}
 */
function perFileUnionDeclarations(gitattributesText) {
  const out = new Set();
  for (const line of String(gitattributesText).split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(\S+)\s+(?:\S+\s+)*merge=union\b/);
    if (m && !/[*?[]/.test(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * @param {string[]} files repo-relative tracked *.jsonl paths
 * @returns {string[]} VERIFIED_UNION_LEDGERS patterns matching no tracked file
 *   (stale: the directory was renamed or emptied, so the entry vouches for nothing)
 */
function findStaleVerifiedUnionPatterns(files) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  return VERIFIED_UNION_MATCHERS.filter((m) => !files.some((f) => m.re.test(f))).map((m) => m.pattern);
}

module.exports = {
  perFileUnionDeclarations,
  EXEMPT_LEDGERS,
  VERIFIED_UNION_LEDGERS,
  isVerifiedUnionPath,
  findUnverifiedUnionLedgers,
  findStaleVerifiedUnionPatterns,
  isExemptLedgerPath,
  findLedgersMissingUnionOrExemption,
  findExemptLedgersWronglyUnioned,
};
