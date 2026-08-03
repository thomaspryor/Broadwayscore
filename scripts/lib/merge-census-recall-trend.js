'use strict';

/**
 * merge-census-recall-trend.js — union merge for data/audit/census-recall-trend.jsonl.
 *
 * Same race class as scraper-spend-ledger.jsonl (task #784) and
 * owner-email-log.jsonl (#809): the recall cron reads the whole ledger, appends
 * a line, and rewrites the file. Any other workflow that commits under
 * data/audit/ in the same window makes push-with-retry rebase — and
 * `rebase -X theirs` resolves in favour of the replayed commit WITHOUT
 * reporting a conflict, so the remote's line is silently gone. Registering here
 * (and setting PUSH_RECONCILE_MERGED_JSON=1 on the workflow) makes the helper
 * re-merge against the remote tip instead.
 *
 * Merge rule: one entry per date, and when both sides hold that date the entry
 * measured against MORE ground truth wins. Recall is a ratio over a sample, so
 * "more truth URLs" is the more evidenced measurement — and it matches the
 * same-day downgrade guard in appendTrendEntry(). Ties keep ours (idempotent
 * re-runs must not churn the file).
 */

const keyOf = (e) => (e && typeof e.date === 'string' && e.date ? e.date : null);

/**
 * @param {Array<object>} oursEntries local ledger lines
 * @param {Array<object>} remoteEntries remote ledger lines
 * @returns {{merged: Array<object>, stats: {added: number, kept: number, replaced: number, total: number}}}
 */
function mergeCensusRecallTrend(oursEntries, remoteEntries) {
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
    if ((e.truthUrls || 0) > (mine.truthUrls || 0)) {
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

module.exports = { mergeCensusRecallTrend, keyOf };
