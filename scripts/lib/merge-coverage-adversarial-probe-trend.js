'use strict';

/**
 * merge-coverage-adversarial-probe-trend.js — union merge for
 * data/audit/coverage-adversarial-probe-trend.jsonl (Coverage Verdict S5,
 * task #903).
 *
 * Same race class census-recall-trend.jsonl already documents (task #784's
 * class): the weekly probe cron reads the whole ledger, appends a line, and
 * rewrites the file. Any other workflow or local run that commits under
 * data/audit/ in the same window makes push-with-retry rebase — and
 * `rebase -X theirs` resolves in favour of the replayed commit WITHOUT
 * reporting a conflict, so the remote's line is silently gone. Registering
 * here (and setting PUSH_RECONCILE_MERGED_JSON=1 on the workflow, already
 * done in coverage-adversarial-probe.yml) makes the helper re-merge against
 * the remote tip instead.
 *
 * Merge rule: one entry per date, and when both sides hold that date the
 * entry that MEASURED MORE SHOWS wins — the same "more evidence wins" rule
 * appendTrendEntry() applies locally in coverage-adversarial-probe.js
 * (a same-day downgrade guard), kept consistent across both layers. Ties
 * keep ours (idempotent re-runs must not churn the file).
 */

const keyOf = (e) => (e && typeof e.date === 'string' && e.date ? e.date : null);

/**
 * @param {Array<object>} oursEntries local ledger lines
 * @param {Array<object>} remoteEntries remote ledger lines
 * @returns {{merged: Array<object>, stats: {added: number, kept: number, replaced: number, total: number}}}
 */
function mergeCoverageAdversarialProbeTrend(oursEntries, remoteEntries) {
  const ours = Array.isArray(oursEntries) ? oursEntries : [];
  const remote = Array.isArray(remoteEntries) ? remoteEntries : [];

  const byDate = new Map();
  const undated = [];
  for (const e of ours) {
    const k = keyOf(e);
    if (k) byDate.set(k, e); else undated.push(e);
  }

  let added = 0;
  let kept = 0;
  let replaced = 0;
  for (const e of remote) {
    const k = keyOf(e);
    if (!k) continue; // a dateless remote line has no identity to merge on
    if (!byDate.has(k)) {
      byDate.set(k, e);
      added += 1;
      continue;
    }
    const mine = byDate.get(k);
    if ((e.measured || 0) > (mine.measured || 0)) {
      byDate.set(k, e);
      replaced += 1;
    } else {
      kept += 1;
    }
  }

  const merged = [...undated, ...[...byDate.values()]]
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return { merged, stats: { added, kept, replaced, total: merged.length } };
}

module.exports = { mergeCoverageAdversarialProbeTrend, keyOf };
