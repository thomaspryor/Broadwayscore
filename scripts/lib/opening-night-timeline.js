'use strict';
/**
 * Pure reader for data/opening-night-timeline/{showId}.jsonl (BRO-2497).
 *
 * Those files are declared `merge=union` in .gitattributes, so a union merge
 * (git's driver, or sync-audit-checkout.sh's union-recovery stage) can leave
 * rows OUT of chronological order: the recovery appends locally-saved rows
 * after origin's rows regardless of their real timestamps. The two consumers
 * in scripts/generate-status-page.js used to trust file order (the dedupe
 * compared against the LAST line; the sparkline plotted in file order and
 * labelled its date range from element [0] and [length-1]). Parsing through
 * this helper re-sorts by the explicit `t` timestamp, which is what makes
 * merge=union safe for these files under the criteria documented in
 * scripts/lib/audit-ledger-merge-attrs.js.
 *
 * Exact-duplicate lines (the same snapshot present on both sides of a merge)
 * collapse to one so a snapshot is never plotted twice.
 *
 * @param {string} text raw file contents
 * @returns {object[]} parsed rows, oldest first; torn/unparseable lines and
 *   rows whose `t` is not a parseable timestamp are dropped
 */
function parseTimelineJsonl(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row.t !== 'string') continue;
    const ms = Date.parse(row.t);
    if (Number.isNaN(ms)) continue;
    rows.push({ row, ms });
  }
  // Numeric instant, not string order: an offset-form or non-zero-padded `t`
  // sorts wrong lexically. Array.prototype.sort is stable, so rows sharing an
  // instant keep file order.
  return rows.sort((a, b) => a.ms - b.ms).map((e) => e.row);
}

module.exports = { parseTimelineJsonl };
